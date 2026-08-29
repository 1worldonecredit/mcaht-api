const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// ---------------------------------------------------------
// 0. ตั้งค่า CORS (จำกัดโดเมนที่อนุญาตให้เข้าถึง API)
// ---------------------------------------------------------
const allowedOrigins = [
  'https://9plus.app',             // โดเมนหลัก
  'https://www.9plus.app',         // โดเมนหลัก (มี www)
  'http://localhost:5173',         // สำหรับทดสอบ Frontend (Vite) บนเครื่องตัวเอง
  'http://localhost:3000'          // สำหรับทดสอบ Frontend (อื่นๆ)
];

const corsOptions = {
  origin: function (origin, callback) {
    // อนุญาต requests ที่ไม่มี origin (เช่น Mobile App หรือ Postman) หรือ origin ที่อยู่ใน whitelist
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('ไม่อนุญาตโดย CORS policy (Not allowed by CORS)'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// ---------------------------------------------------------
// เชื่อมต่อฐานข้อมูล PostgreSQL (Neon)
// ---------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------------------------------------------------
// ฟังก์ชัน 1: สร้างรหัสประจำตัวตามโครงสร้างของคุณ (TS -> JS)
// ---------------------------------------------------------
function generateGlobalId(data) {
  const country = data.countryCode.substring(0, 3).toUpperCase();
  const year = data.birthYear.toString().slice(-2);
  const genderReligion = `${data.gender}${data.religion}`;
  const region = data.regionCode.substring(0, 3).toUpperCase();
  const uniqueNum = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
  
  return `${country}-${year}-${genderReligion}-${region}-${uniqueNum}`;
}

// ---------------------------------------------------------
// ฟังก์ชัน 2: คำนวณอายุและอายุการใช้งาน (ปี, เดือน, วัน)
// ---------------------------------------------------------
function calculateDetailedAge(startDate) {
  const start = new Date(startDate);
  const end = new Date(); // วันปัจจุบัน

  let years = end.getFullYear() - start.getFullYear();
  let months = end.getMonth() - start.getMonth();
  let days = end.getDate() - start.getDate();

  if (days < 0) {
    months--;
    // หาวันสิ้นเดือนของเดือนก่อนหน้า
    const lastMonth = new Date(end.getFullYear(), end.getMonth(), 0);
    days += lastMonth.getDate();
  }
  if (months < 0) {
    years--;
    months += 12;
  }

  return { years, months, days };
}

// ---------------------------------------------------------
// API 1: จำลองการสร้างผู้ใช้งานใหม่ (Register)
// ---------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { username, phone, birthYear, birthMonth, birthDay, gender, religion, countryCode, regionCode, referrerId } = req.body;

  try {
    // 1. สร้าง Global ID
    const globalId = generateGlobalId({
      countryCode, birthYear, gender, religion, regionCode
    });

    const dateOfBirth = `${birthYear}-${birthMonth.toString().padStart(2, '0')}-${birthDay.toString().padStart(2, '0')}`;

    // 2. บันทึกลงฐานข้อมูล
    const insertQuery = `
      INSERT INTO users (global_id, username, phone, date_of_birth, gender, religion, country_code, region_code, referrer_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *;
    `;
    const values = [globalId, username, phone, dateOfBirth, gender, religion, countryCode, regionCode, referrerId || null];
    
    const result = await pool.query(insertQuery, values);
    res.json({ success: true, message: 'ลงทะเบียนสำเร็จ', user: result.rows[0] });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'ลงทะเบียนล้มเหลว' });
  }
});

// ---------------------------------------------------------
// API 2: ดึงข้อมูลหน้า Profile (คำนวณ Level, อายุ และดึงข้อมูลหลายตาราง)
// ---------------------------------------------------------
app.get('/api/profile/:id', async (req, res) => {
  const userId = req.params.id;

  try {
    // ใช้ SQL JOIN และ COUNT แบบย่อย เพื่อดึงข้อมูลเพื่อนและผู้ติดตาม
    const query = `
      SELECT 
        u.*,
        (SELECT COUNT(*) FROM friends WHERE user_id = u.id) AS friends_count,
        (SELECT COUNT(*) FROM followers WHERE channel_owner_id = u.id) AS followers_count,
        r.username AS referrer_name
      FROM users u
      LEFT JOIN users r ON u.referrer_id = r.id
      WHERE u.id = $1;
    `;
    
    const result = await pool.query(query, [userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
    }

    const userData = result.rows[0];

    // คำนวณอายุจริง
    const age = calculateDetailedAge(userData.date_of_birth);
    // คำนวณอายุการใช้งานระบบ
    const accountAge = calculateDetailedAge(userData.created_at);

    // ---------------------------------------------------------
    // ตรรกะการคำนวณ Level
    // ---------------------------------------------------------
    let calculatedLevel = 1; 
    const friendsCount = parseInt(userData.friends_count) || 0;
    const followersCount = parseInt(userData.followers_count) || 0;

    calculatedLevel += Math.floor(friendsCount / 10);
    calculatedLevel += Math.floor(followersCount / 50);
    
    if (userData.is_referrer_verified) {
        calculatedLevel += 2; 
    }

    // สรุปข้อมูลส่งกลับไปให้ Frontend ไปวาดเป็น UI
    const profileResponse = {
      global_id: userData.global_id,
      username: userData.username,
      phone: userData.phone,
      nationality: userData.nationality,
      gender: userData.gender,
      demographics: {
        birth_date: userData.date_of_birth,
        age: `${age.years} ปี ${age.months} เดือน ${age.days} วัน`,
        account_age: `${accountAge.years} ปี ${accountAge.months} เดือน ${accountAge.days} วัน`,
      },
      stats: {
        friends: friendsCount,
        followers: followersCount,
        current_level: calculatedLevel
      },
      settings: {
        currency: userData.currency,
        timezone: userData.timezone,
        role: userData.role
      },
      referral: {
        referrer_id: userData.referrer_id,
        referrer_name: userData.referrer_name || 'ไม่มี',
        is_verified: userData.is_referrer_verified
      }
    };

    res.json({ success: true, profile: profileResponse });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'ดึงข้อมูลโปรไฟล์ล้มเหลว' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`M-Chat Server running on port ${PORT}`));