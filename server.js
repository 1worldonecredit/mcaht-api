const express = require('express');
const bcrypt = require('bcrypt');
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
app.use(cors({
  origin: function (origin, callback) {
    // อนุญาต request ที่ไม่มี origin (เช่น Postman) หรือ origin ที่อยู่ใน whitelist
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('ไม่อนุญาตโดย CORS policy (Not allowed by CORS)'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));


// เพิ่ม limit ให้รองรับไฟล์รูปภาพขนาดใหญ่ (ใส่ไว้บรรทัดบนๆ ของ server.js)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


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


// API: ดึงข้อมูล Master Data สำหรับหน้าลงทะเบียน
app.get('/api/reference-data', async (req, res) => {
  try {
    const countries = await pool.query('SELECT code, name_en as name FROM ref_countries ORDER BY code DESC');
    const genders = await pool.query('SELECT code, name_en as name FROM ref_genders');
    
    res.json({ 
      success: true, 
      countries: countries.rows, 
      genders: genders.rows 
    });
  } catch (error) {
    console.error('Fetch Ref Data Error:', error);
    res.status(500).json({ success: false, error: 'ไม่สามารถดึงข้อมูลอ้างอิงได้' });
  }
});


// API: ตรวจสอบ Username ซ้ำแบบ Real-time (พร้อมดึงข้อมูลมาแสดงเป็นผู้แนะนำ)
app.post('/api/check-username', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อผู้ใช้' });

  try {
    // ดึงข้อมูลจากตาราง users_core (หากคุณมีตาราง user_details ที่เก็บชื่อ-นามสกุล ให้ใช้ JOIN เพิ่มในบรรทัดนี้ได้เลยครับ)
    const check = await pool.query('SELECT id, username FROM users_core WHERE username = $1', [username]);
    
    if (check.rows.length > 0) {
      return res.json({ 
        success: true, 
        available: false, 
        userData: {
          // หากในอนาคตมีคอลัมน์ชื่อจริง ให้แก้เป็น: displayName: `${check.rows[0].first_name} ${check.rows[0].last_name}`
          displayName: check.rows[0].username 
        }
      });
    }
    return res.json({ success: true, available: true });
  } catch (error) {
    console.error('Check Username Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});
// ---------------------------------------------------------
// API: ลงทะเบียนผู้ใช้ใหม่ (พร้อมเข้ารหัสผ่าน & สิทธิ์ & ผู้แนะนำ)
// ---------------------------------------------------------
app.post('/api/register/basic', async (req, res) => {
  const { username, password, country, gender, dob, referrer } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, message: 'ระบบไม่ได้รับข้อมูลรหัสผ่าน' });
  }

  try {
    // 1. ตรวจสอบว่า Username ซ้ำหรือไม่
    const checkUser = await pool.query('SELECT id FROM users_core WHERE username = $1', [username]);
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว กรุณาเลือกชื่ออื่น' });
    }

    // 2. ตรวจสอบผู้แนะนำ (ถ้ามีการกรอกเข้ามา)
    let referrerId = null;
    if (referrer) {
      const refCheck = await pool.query('SELECT id FROM users_core WHERE username = $1', [referrer]);
      if (refCheck.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'REFERRAL ERROR: ไม่พบชื่อผู้แนะนำนี้ในระบบ' });
      }
      referrerId = refCheck.rows[0].id;
    }

    // 3. เข้ารหัสผ่าน
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // 4. เริ่ม Transaction
    await pool.query('BEGIN');

    // 5. บันทึกลงตารางแกนกลาง พร้อมเก็บ referrer_id
    const coreResult = await pool.query(
      `INSERT INTO users_core (username, account_status, referrer_id) VALUES ($1, 'active', $2) RETURNING id`,
      [username, referrerId]
    );
    const newUserId = coreResult.rows[0].id;

    // 6. บันทึกรหัสผ่าน
    await pool.query(
      `INSERT INTO user_auth (user_id, auth_type, auth_data) VALUES ($1, 'password', $2)`,
      [newUserId, hashedPassword]
    );

    // 7. สร้าง Global ID
    const birthYear = new Date(dob).getFullYear();
    const globalIdData = {
      countryCode: country,
      birthYear: birthYear,
      gender: gender,
      religion: '1',
      regionCode: 'BKK'
    };
    const realGlobalId = generateGlobalId(globalIdData); 

    // 8. บันทึกข้อมูลส่วนตัว (ให้ phone เป็น NULL ตามที่เราแก้ไว้)
    await pool.query(
      `INSERT INTO users (id, username, global_id, phone, date_of_birth, nationality, gender) 
       VALUES ($1, $2, $3, NULL, $4, $5, $6)`, 
      [newUserId, username, realGlobalId, dob, country, gender]
    );

    // 9. กำหนดสิทธิ์
    await pool.query(
      `INSERT INTO user_roles (user_id, role_code) VALUES ($1, 'USER')`,
      [newUserId]
    );

    await pool.query('COMMIT');
    res.json({ success: true, message: 'สร้างบัญชีสำเร็จ', userId: newUserId });

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Register API Error:', error);
    res.status(500).json({ success: false, message: 'ระบบขัดข้อง ไม่สามารถสร้างบัญชีได้' });
  }
});

// ---------------------------------------------------------
// API: เข้าสู่ระบบ (Login & ตรวจสอบสิทธิ์)
// ---------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'MISSING DATA: กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  }

  try {
    // 1. ตรวจสอบการมีอยู่และสถานะของบัญชี
    const userQuery = await pool.query('SELECT id, account_status FROM users_core WHERE username = $1', [username]);
    if (userQuery.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'ACCESS DENIED: ไม่พบชื่อผู้ใช้นี้ในระบบ' });
    }

    const user = userQuery.rows[0];
    if (user.account_status !== 'active') {
      return res.status(403).json({ success: false, message: 'ACCOUNT SUSPENDED: บัญชีนี้ถูกระงับการใช้งาน' });
    }

    // 2. ดึงรหัสผ่านที่เข้ารหัสไว้มาเปรียบเทียบ
    const authQuery = await pool.query(`SELECT auth_data FROM user_auth WHERE user_id = $1 AND auth_type = 'password'`, [user.id]);
    if (authQuery.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'AUTH ERROR: บัญชีนี้ไม่ได้ตั้งรหัสผ่าน (อาจสมัครด้วย Social)' });
    }

    const isValidPassword = await bcrypt.compare(password, authQuery.rows[0].auth_data);
    if (!isValidPassword) {
      return res.status(401).json({ success: false, message: 'ACCESS DENIED: รหัสผ่านไม่ถูกต้อง' });
    }

    // 3. ดึงสิทธิ์ผู้ใช้งาน (Roles) ไปใช้ควบคุมหน้าต่างส่วนต่างๆ ในแอป
    const roleQuery = await pool.query('SELECT role_code FROM user_roles WHERE user_id = $1', [user.id]);
    const roles = roleQuery.rows.map(r => r.role_code);

    res.json({ 
      success: true, 
      userId: user.id,
      username: username,
      roles: roles.length > 0 ? roles : ['USER'] 
    });

  } catch (error) {
    console.error('Login API Error:', error);
    res.status(500).json({ success: false, message: 'SYSTEM ERROR: ระบบขัดข้อง ไม่สามารถเข้าสู่ระบบได้' });
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
// API 2: ดึงข้อมูลหน้า Profile (Single Query ปรับให้ตรงกับ Database จริง 100%)
// ---------------------------------------------------------
app.get('/api/profile/:id', async (req, res) => {
  const userId = req.params.id;

  try {
   // เพิ่ม up.id_card เข้าไปใน SELECT
    const query = `
      SELECT 
        u.*,
        (SELECT COUNT(*) FROM friends WHERE user_id = u.id) AS friends_count,
        (SELECT COUNT(*) FROM followers WHERE channel_owner_id = u.id) AS followers_count,
        r.username AS referrer_name,
        up.display_name, up.phone AS up_phone, up.avatar_url AS up_avatar, up.cover_url AS up_cover, up.id_card,
        (SELECT contact_value FROM user_contacts WHERE user_id = u.id AND contact_type = 'email' LIMIT 1) AS email,
        (SELECT is_verified FROM user_contacts WHERE user_id = u.id AND contact_type = 'email' LIMIT 1) AS is_email_verified,
        (SELECT is_verified FROM user_contacts WHERE user_id = u.id AND contact_type = 'phone' LIMIT 1) AS is_phone_verified,
        ud.avatar_url AS ud_avatar
      FROM users u
      LEFT JOIN users r ON u.referrer_id = r.id
      LEFT JOIN user_profile up ON up.user_id = u.id
      LEFT JOIN user_display ud ON ud.user_id = u.id
      WHERE u.id = $1;
    `;
    
    const result = await pool.query(query, [userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
    }

    const userData = result.rows[0];

    const age = calculateDetailedAge(userData.date_of_birth);
    const accountAge = calculateDetailedAge(userData.created_at);

    let calculatedLevel = 1; 
    const friendsCount = parseInt(userData.friends_count) || 0;
    const followersCount = parseInt(userData.followers_count) || 0;

    calculatedLevel += Math.floor(friendsCount / 10);
    calculatedLevel += Math.floor(followersCount / 50);
    
    if (userData.is_referrer_verified) {
        calculatedLevel += 2; 
    }

    const profileResponse = {
      global_id: userData.global_id,
      username: userData.username,
      
      // แมปข้อมูลให้ตรงกับที่ Frontend (Profile.jsx) รอรับ
      first_name: userData.display_name || '', // ดึงจาก display_name แทน
      last_name: '', // โครงสร้างคุณไม่มีคอลัมน์นี้ ปล่อยว่างไว้กันระบบพัง
      id_card: userData.id_card || '',
      phone: userData.up_phone || userData.phone || '',
      email: userData.email || '',
      is_phone_verified: userData.is_phone_verified || false,
      is_email_verified: userData.is_email_verified || false,
      avatar_url: userData.up_avatar || userData.ud_avatar || '',
      cover_url: userData.up_cover || '',

      nationality: userData.nationality,
      gender: userData.gender,
      demographics: {
        birth_date: userData.date_of_birth,
        age: `${age?.years || 0} ปี ${age?.months || 0} เดือน ${age?.days || 0} วัน`,
        account_age: `${accountAge?.years || 0} ปี ${accountAge?.months || 0} เดือน ${accountAge?.days || 0} วัน`,
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
        referrer_name: userData.referrer_name || 'ไม่มีผู้แนะนำ',
        is_verified: userData.is_referrer_verified
      }
    };

    res.json({ success: true, profile: profileResponse });

  } catch (error) {
    console.error('API Profile Error:', error);
    res.status(500).json({ success: false, error: 'ดึงข้อมูลโปรไฟล์ล้มเหลว' });
  }
});

// ---------------------------------------------------------
// API: บันทึกข้อมูลส่วนบุคคล (ชื่อ, โทรศัพท์, อีเมล, บัตรประชาชน)
// ---------------------------------------------------------
app.post('/api/profile/update', async (req, res) => {
  const { userId, field, firstName, lastName, phone, email, idCard } = req.body;

  try {
    if (field === 'name') {
      // ฐานข้อมูลคุณมีแค่คอลัมน์ display_name จึงต้องเอาชื่อ-นามสกุลมาต่อกันก่อนบันทึก
      const fullName = `${firstName} ${lastName}`.trim();
      await pool.query(
        `UPDATE user_profile SET display_name = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
        [fullName, userId]
      );
    } 
    else if (field === 'phone') {
      // อัปเดตเบอร์โทรในตาราง user_profile
      await pool.query(
        `UPDATE user_profile SET phone = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
        [phone, userId]
      );
    } 
    else if (field === 'email') {
      // อีเมลถูกเก็บใน user_contacts แบบแนวตั้ง (contact_type = 'email')
      const checkEmail = await pool.query(`SELECT id FROM user_contacts WHERE user_id = $1 AND contact_type = 'email'`, [userId]);
      
      if (checkEmail.rows.length > 0) {
        await pool.query(
          `UPDATE user_contacts SET contact_value = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND contact_type = 'email'`,
          [email, userId]
        );
      } else {
        await pool.query(
          `INSERT INTO user_contacts (user_id, contact_type, contact_value, created_at) VALUES ($1, 'email', $2, CURRENT_TIMESTAMP)`,
          [userId, email]
        );
      }
    }
    else if (field === 'idcard') {
      // อัปเดตเลขบัตรประชาชน
      await pool.query(
        `UPDATE user_profile SET id_card = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
        [idCard, userId]
      );
    }

    res.json({ success: true, message: 'อัปเดตข้อมูลสำเร็จ' });

  } catch (error) {
    console.error('Update Profile API Error:', error);
    res.status(500).json({ success: false, message: 'ระบบขัดข้อง บันทึกข้อมูลไม่สำเร็จ' });
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
// ---------------------------------------------------------
// API: บันทึกรูปภาพ (Profile & Cover) ลงตาราง user_profile
// ---------------------------------------------------------
app.post('/api/profile/upload-image', async (req, res) => {
  const { userId, type, imageBase64 } = req.body;
  
  try {
    // กำหนดคอลัมน์ที่ต้องการอัปเดต (avatar หรือ cover)
    const column = type === 'avatar' ? 'avatar_url' : 'cover_url';
    
    // 1. เช็คว่ามีข้อมูลผู้ใช้นี้ในตาราง user_profile หรือยัง
    const checkQuery = await pool.query(`SELECT id FROM user_profile WHERE user_id = $1`, [userId]);
    
    if (checkQuery.rows.length > 0) {
      // ถ้ามีเรคคอร์ดแล้ว ให้อัปเดตข้อมูล
      await pool.query(
        `UPDATE user_profile SET ${column} = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`, 
        [imageBase64, userId]
      );
    } else {
      // ถ้ายังไม่มีเรคคอร์ด ให้สร้างใหม่พร้อมบันทึกรูป
      await pool.query(
        `INSERT INTO user_profile (user_id, ${column}, created_at) VALUES ($1, $2, CURRENT_TIMESTAMP)`, 
        [userId, imageBase64]
      );
    }
    
    res.json({ success: true, message: 'บันทึกรูปภาพสำเร็จ' });
  } catch (error) {
    console.error('Image Upload API Error:', error);
    res.status(500).json({ success: false, error: 'บันทึกรูปล้มเหลว' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`M-Chat Server running on port ${PORT}`));