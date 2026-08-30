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
  'https://www.9plus.app', 
  'https://mchatapi.9plus.app',
  'https://mchat.9plus.app',
  'https://www.mchatapi.9plus.app',    // โดเมนหลัก (มี www)
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

// API: ลงทะเบียนบัญชีพื้นฐาน (สร้างเฉพาะ ID โดยที่ global_id ยังเป็น NULL)
app.post('/api/register/basic', async (req, res) => {
  const { username, password } = req.body;

  try {
    // 1. เช็คว่ามี Username นี้ในตาราง users_core หรือยัง
    const checkUser = await pool.query('SELECT id FROM users_core WHERE username = $1', [username]);
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว' });
    }

    // 2. ใช้ Transaction บันทึกลงตารางที่เกี่ยวข้องพร้อมกัน (ป้องกันข้อมูลพังถ้ามี Error)
    await pool.query('BEGIN');

    // Insert ลง users_core
    const coreResult = await pool.query(
      `INSERT INTO users_core (username, account_status) VALUES ($1, 'pending') RETURNING id`,
      [username]
    );
    const newUserId = coreResult.rows[0].id;

    // Insert ลง user_auth (สำหรับระบบจริง ควร Hash Password ก่อนลง Database เสมอ)
    await pool.query(
      `INSERT INTO user_auth (user_id, auth_type, auth_data) VALUES ($1, 'password', $2)`,
      [newUserId, password]
    );

    // 3. (ส่วนที่เพิ่มเข้ามา) สร้างข้อมูลตั้งต้นในตาราง "users" เพื่อไม่ให้หน้า Profile โหลดค้าง
    await pool.query(
      `INSERT INTO users (id, username) VALUES ($1, $2)`, 
      [newUserId, username]
    );

    await pool.query('COMMIT');
    res.json({ success: true, message: 'สร้างบัญชีเริ่มต้นสำเร็จ', userId: newUserId });

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Register API Error:', error);
    res.status(500).json({ success: false, error: 'ระบบขัดข้อง ไม่สามารถสร้างบัญชีได้' });
  }
});

// API: เข้าสู่ระบบ (Login)
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // ดึงข้อมูล user และรหัสผ่านจาก 2 ตารางมาเช็ค
    const userQuery = await pool.query(`
      SELECT c.id, a.auth_data 
      FROM users_core c 
      JOIN user_auth a ON c.id = a.user_id 
      WHERE c.username = $1 AND a.auth_type = 'password'
    `, [username]);

    if (userQuery.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่พบชื่อผู้ใช้นี้ในระบบ' });
    }

    // เทียบรหัสผ่าน (ระบบจริงควรใช้ bcrypt.compare)
    const storedPassword = userQuery.rows[0].auth_data;
    if (password !== storedPassword) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ', userId: userQuery.rows[0].id });

  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'ระบบขัดข้อง ไม่สามารถเข้าสู่ระบบได้' });
  }
});

// ---------------------------------------------------------
// API: เปลี่ยนรหัสผ่าน (Change Password)
// ---------------------------------------------------------
app.post('/api/profile/change-password', async (req, res) => {
  const { userId, oldPassword, newPassword } = req.body;

  try {
    // 1. ดึงรหัสผ่านเดิมจากฐานข้อมูลมาเช็คก่อน
    const userQuery = await pool.query(
      `SELECT auth_data FROM user_auth WHERE user_id = $1 AND auth_type = 'password'`,
      [userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบบัญชีผู้ใช้' });
    }

    const currentPassword = userQuery.rows[0].auth_data;
    
    // 2. ถ้ารหัสผ่านเดิมผิด ให้เตะกลับ
    if (currentPassword !== oldPassword) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    }

    // 3. ถ้ารหัสผ่านเดิมถูก ให้อัปเดตเป็นรหัสผ่านใหม่
    await pool.query(
      `UPDATE user_auth SET auth_data = $1 WHERE user_id = $2 AND auth_type = 'password'`,
      [newPassword, userId]
    );

    res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });

  } catch (error) {
    console.error('Change Password Error:', error);
    res.status(500).json({ success: false, message: 'ระบบขัดข้อง ไม่สามารถเปลี่ยนรหัสผ่านได้' });
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

// ---------------------------------------------------------
// API 3: ดึงข้อมูลการ์ดย่อย (Dynamic Details) ที่ยังไม่ถูกลบ
// ---------------------------------------------------------
app.get('/api/profile/:userId/details', async (req, res) => {
    try {
        const { userId } = req.params;
        const query = `SELECT * FROM user_details WHERE user_id = $1 AND is_active = 1 ORDER BY created_at DESC`;
        const { rows } = await pool.query(query, [userId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------
// API 4: บันทึกข้อมูลการ์ดย่อย พร้อมระบบตรวจสอบซ้ำ (Unique & Duplicate)
// ---------------------------------------------------------
app.post('/api/profile/details', async (req, res) => {
    try {
        const { userId, type, title, subtitle, desc } = req.body;
        
        // 1. ตรวจสอบเงื่อนไข Unique (เช่น ที่อยู่ หรือ สุขภาพ มีได้แค่ 1 อัน)
        const uniqueTypes = ['address', 'health'];
        if (uniqueTypes.includes(type)) {
            const checkUnique = await pool.query(`SELECT id FROM user_details WHERE user_id = $1 AND type = $2 AND is_active = 1`, [userId, type]);
            if (checkUnique.rows.length > 0) {
                return res.status(400).json({ error: 'ข้อมูลประเภทนี้มีอยู่แล้วในระบบ (ไม่อนุญาตให้ซ้ำ)' });
            }
        }

        // 2. ตรวจสอบ Duplicate (ห้ามพิมพ์ Title เหมือนกันในหมวดเดียวกัน)
        const checkDuplicate = await pool.query(
            `SELECT id FROM user_details WHERE user_id = $1 AND type = $2 AND LOWER(title) = LOWER($3) AND is_active = 1`, 
            [userId, type, title]
        );
        if (checkDuplicate.rows.length > 0) {
            return res.status(400).json({ error: `มีข้อมูล "${title}" ในระบบแล้ว` });
        }

        const insertQuery = `
            INSERT INTO user_details (user_id, type, title, subtitle, description) 
            VALUES ($1, $2, $3, $4, $5) RETURNING *
        `;
        const { rows } = await pool.query(insertQuery, [userId, type, title, subtitle, desc]);
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------
// API 5: ลบข้อมูลการ์ดย่อยแบบ Soft Delete (เปลี่ยน is_active = 0)
// ---------------------------------------------------------
app.put('/api/profile/details/:id/delete', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `UPDATE user_details SET is_active = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`;
        const { rows } = await pool.query(query, [id]);
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`M-Chat Server running on port ${PORT}`));