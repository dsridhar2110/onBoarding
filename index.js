import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import 'dotenv/config';

const app = express();

// --- CORS: allow your local dev + your friend's GitHub Pages ---
const allowed = [
  'http://localhost:5173',
  'http://localhost:8080',
  'https://fzl249020.github.io',
  'https://fzl249020.github.io/vue-fit5120-onboardingproject'
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl/postman
    if (allowed.some(a => origin.startsWith(a))) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));

// --- MySQL connection pool to AWS RDS ---
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  ssl: { rejectUnauthorized: false } // simple SSL for RDS
});

// --- Health check ---
app.get('/health', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: rows[0].ok === 1 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'DB_ERROR' });
  }
});

// --- Data endpoint (quarterly line + tooltip values in one call) ---
app.get('/api/vehicle/quarterly', async (_req, res) => {
  const sql = `
  SELECT
    CONCAT('Q',q.qtr,'-',q.yr) AS quarter_label,
    q.yr                       AS year,
    q.qtr                      AS quarter,
    CASE WHEN v.delta_number IS NULL THEN 0
         ELSE FLOOR(v.delta_number * w.weight) END AS est_added_vehicles,
    ROUND(
      100 * EXP(
        SUM(LOG(
          CASE WHEN v.delta_percent IS NULL THEN 1.0
               ELSE POW(1 + v.delta_percent/100, w.weight) END
        )) OVER (ORDER BY q.yr, q.qtr)
      ), 4
    ) AS index_val
  FROM (
    SELECT 2016 AS yr,1 AS qtr UNION ALL SELECT 2016,2 UNION ALL SELECT 2016,3 UNION ALL SELECT 2016,4
    UNION ALL SELECT 2017,1 UNION ALL SELECT 2017,2 UNION ALL SELECT 2017,3 UNION ALL SELECT 2017,4
    UNION ALL SELECT 2018,1 UNION ALL SELECT 2018,2 UNION ALL SELECT 2018,3 UNION ALL SELECT 2018,4
    UNION ALL SELECT 2019,1 UNION ALL SELECT 2019,2 UNION ALL SELECT 2019,3 UNION ALL SELECT 2019,4
    UNION ALL SELECT 2020,1 UNION ALL SELECT 2020,2 UNION ALL SELECT 2020,3 UNION ALL SELECT 2020,4
    UNION ALL SELECT 2021,1 UNION ALL SELECT 2021,2 UNION ALL SELECT 2021,3 UNION ALL SELECT 2021,4
  ) q
  LEFT JOIN (
    SELECT end_year AS yr, delta_number, delta_percent
    FROM vehicle_reg_yoy
    WHERE region_code='VIC'
  ) v ON v.yr = q.yr
  LEFT JOIN (
    SELECT 2017 yr,1 qtr,0.30 weight UNION ALL SELECT 2017,2,0.23 UNION ALL SELECT 2017,3,0.22 UNION ALL SELECT 2017,4,0.25
    UNION ALL SELECT 2018,1,0.29 UNION ALL SELECT 2018,2,0.23 UNION ALL SELECT 2018,3,0.22 UNION ALL SELECT 2018,4,0.26
    UNION ALL SELECT 2019,1,0.29 UNION ALL SELECT 2019,2,0.23 UNION ALL SELECT 2019,3,0.22 UNION ALL SELECT 2019,4,0.26
    UNION ALL SELECT 2020,1,0.28 UNION ALL SELECT 2020,2,0.18 UNION ALL SELECT 2020,3,0.18 UNION ALL SELECT 2020,4,0.36
    UNION ALL SELECT 2021,1,0.28 UNION ALL SELECT 2021,2,0.26 UNION ALL SELECT 2021,3,0.24 UNION ALL SELECT 2021,4,0.22
  ) w ON w.yr=q.yr AND w.qtr=q.qtr
  ORDER BY q.yr, q.qtr;
  `;
  try {
    const [rows] = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

// GET /api/parking/markers
// One endpoint that covers: default load, search (street/zone), and filters.
// GET /api/parking/markers  (default load, search, filters)
app.get('/api/parking/markers', async (req, res) => {
  const { street, zone, years, months, days, hh, mm } = req.query;

  const toIntList = (s) =>
    (s ? String(s).split(',').map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n)) : []);
  const dayNums = (s) => {
    if (!s) return [];
    const map = { sun:1, mon:2, tue:3, wed:4, thu:5, fri:6, sat:7 }; // MySQL: Sun=1..Sat=7
    return String(s).split(',')
      .map(x => x.trim())
      .map(x => (/^\d+$/.test(x) ? parseInt(x,10) : map[x.toLowerCase().slice(0,3)]))
      .filter(Boolean);
  };
  const placeholders = (n) => Array(n).fill('?').join(',');

  // parse first, then decide if filters are active
  const yrs = toIntList(years);
  const mos = toIntList(months);
  const dws = dayNums(days);
  const haveTime = hh != null && mm != null && String(hh) !== '' && String(mm) !== '';
  const hasFilters = yrs.length > 0 || mos.length > 0 || dws.length > 0 || haveTime;

  const select = `
    SELECT
      b.bay_id, b.zone_number, b.status_desc, b.status_timestamp, b.lat, b.lng,
      CASE WHEN b.status_desc='Present' THEN 'P' ELSE 'U' END AS status_code,
      GROUP_CONCAT(DISTINCT s.on_street ORDER BY s.on_street SEPARATOR ', ') AS streets,
      GROUP_CONCAT(DISTINCT CONCAT(r.restriction_days,' ',
        DATE_FORMAT(r.time_start,'%H:%i'),'-',DATE_FORMAT(r.time_finish,'%H:%i'),' ', r.restriction_display)
        SEPARATOR '; ') AS restrictions
  `;
  const joinCommon = `
      LEFT JOIN parking_zone_streets      s ON s.zone_number = b.zone_number
      LEFT JOIN parking_zone_restrictions r ON r.zone_number = b.zone_number
  `;

  let sql, params = [];

  if (!hasFilters) {
    // default (latest snapshot) + optional search
    sql = `
      ${select}
      FROM vw_latest_bay_status b
      ${street ? 'JOIN parking_zone_streets zs ON zs.zone_number = b.zone_number' : ''}
      ${joinCommon}
      WHERE 1=1
        AND b.zone_number <> 0
      ${zone   ? ' AND b.zone_number = ?' : ''}
      ${street ? ' AND LOWER(zs.on_street) LIKE LOWER(CONCAT(\'%\', ?, \'%\'))' : ''}
      GROUP BY b.bay_id, b.zone_number, b.status_desc, b.status_timestamp, b.lat, b.lng
    `;
    if (zone)   params.push(Number(zone));
    if (street) params.push(String(street));
  } else {
    // filtered view: pick max ts per bay within filters
    const subWhere = [];
    if (yrs.length) { subWhere.push(`YEAR(status_timestamp) IN (${placeholders(yrs.length)})`); params.push(...yrs); }
    if (mos.length) { subWhere.push(`MONTH(status_timestamp) IN (${placeholders(mos.length)})`); params.push(...mos); }
    if (dws.length) { subWhere.push(`DAYOFWEEK(status_timestamp) IN (${placeholders(dws.length)})`); params.push(...dws); }
    if (haveTime)   { subWhere.push(`TIME(status_timestamp) <= MAKETIME(?, ?, 0)`); params.push(Number(hh)||0, Number(mm)||0); }

    const sub = `
      SELECT bay_id, MAX(status_timestamp) AS max_ts
      FROM parking_bay_history
      ${subWhere.length ? 'WHERE ' + subWhere.join(' AND ') : ''}
      GROUP BY bay_id
    `;

    sql = `
      ${select}
      FROM parking_bay_history b
      JOIN (${sub}) m ON m.bay_id = b.bay_id AND m.max_ts = b.status_timestamp
      ${street ? 'JOIN parking_zone_streets zs ON zs.zone_number = b.zone_number' : ''}
      ${joinCommon}
      WHERE 1=1
        AND b.zone_number <> 0
      ${zone   ? ' AND b.zone_number = ?' : ''}
      ${street ? ' AND LOWER(zs.on_street) LIKE LOWER(CONCAT(\'%\', ?, \'%\'))' : ''}
      GROUP BY b.bay_id, b.zone_number, b.status_desc, b.status_timestamp, b.lat, b.lng
    `;
    if (zone)   params.push(Number(zone));
    if (street) params.push(String(street));
  }

  try {
    await pool.query('SET SESSION group_concat_max_len = 8192');
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB_ERROR' });
  }
});


app.get('/api/parking/meta', async (_req, res) => {
  try {
    const [years]  = await pool.query('SELECT DISTINCT YEAR(status_timestamp) AS year FROM parking_bay_history ORDER BY year');
    const [months] = await pool.query('SELECT DISTINCT MONTH(status_timestamp) AS month FROM parking_bay_history ORDER BY month');
    const [streets]= await pool.query('SELECT DISTINCT on_street FROM parking_zone_streets ORDER BY on_street');
    const [zones]  = await pool.query('SELECT DISTINCT zone_number FROM parking_bay_history WHERE zone_number<>0 ORDER BY zone_number');
    res.json({ years: years.map(r=>r.year), months: months.map(r=>r.month), streets: streets.map(r=>r.on_street), zones: zones.map(r=>r.zone_number) });
  } catch (e) { console.error(e); res.status(500).json({ error:'DB_ERROR' }); }
});


app.get('/api/parking/exists', async (req, res) => {
  const { street, zone } = req.query;
  try {
    let streetExists=false, zoneExists=false, historyExists=false;
    if (street) {
      const [s]=await pool.query('SELECT 1 FROM parking_zone_streets WHERE LOWER(on_street) LIKE LOWER(CONCAT("%",?,"%")) LIMIT 1',[street]);
      streetExists = s.length>0;
    }
    if (zone) {
      const [z]=await pool.query('SELECT 1 FROM parking_bay_history WHERE zone_number=? LIMIT 1',[Number(zone)]);
      zoneExists = z.length>0;
    }
    // If a street exists, check whether any history is linked to it
    if (streetExists) {
      const [h]=await pool.query(`
        SELECT 1 FROM parking_bay_history b
        JOIN parking_zone_streets s ON s.zone_number=b.zone_number
        WHERE LOWER(s.on_street) LIKE LOWER(CONCAT("%",?,"%")) LIMIT 1`, [street]);
      historyExists = h.length>0;
    } else if (zoneExists) {
      historyExists = true; // zone exists in history by definition
    }
    res.json({ streetExists, zoneExists, historyExists });
  } catch (e) { console.error(e); res.status(500).json({ error:'DB_ERROR' }); }
});


// --- Start server (Render will inject PORT) ---
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API listening on port ${port}`));
