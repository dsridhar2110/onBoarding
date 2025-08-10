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

// --- Start server (Render will inject PORT) ---
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API listening on port ${port}`));
