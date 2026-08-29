const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// On Railway, use /data volume if available, otherwise local
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(
    path.join(dataDir, "database.sqlite")
);

db.pragma("foreign_keys = ON");

/* ========================================
   USERS
======================================== */

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        verified INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        last_ip TEXT,
        last_device TEXT,
        last_login TEXT,
        created_at TEXT NOT NULL
    )
`);


/* ========================================
   ADMINS
======================================== */

db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
`);


/* ========================================
   LOGIN HISTORY
======================================== */

db.exec(`
    CREATE TABLE IF NOT EXISTS login_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    )
`);


/* ========================================
   DATABASE MIGRATIONS
======================================== */

function getColumns(table) {
    return db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(row => row.name);
}

/* ========================================
   DASHBOARD TABLES
======================================== */

db.exec(`
    CREATE TABLE IF NOT EXISTS settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        reference TEXT,
        amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'Pending',
        created_at TEXT NOT NULL,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    )
`);

/* balance migration */
let dashboardUserColumns = getColumns('users');
if (!dashboardUserColumns.includes('balance')) {
    db.exec(`ALTER TABLE users ADD COLUMN balance REAL NOT NULL DEFAULT 0`);
    console.log('Added users.balance');
}

/* ========================================
   WITHDRAWALS
======================================== */

db.exec(`
    CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        account_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        bank_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending',
        note TEXT,
        created_at TEXT NOT NULL,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    )
`);

/* ========================================
   INVITATION CODES
======================================== */

db.exec(`
    CREATE TABLE IF NOT EXISTS invitation_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        owner_id INTEGER NOT NULL,
        used_by INTEGER,
        used_at TEXT,
        created_at TEXT NOT NULL,

        FOREIGN KEY (owner_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    )
`);

/* invitation_code column on users */
let inviteUserColumns = getColumns('users');
if (!inviteUserColumns.includes('invitation_code')) {
    db.exec(`ALTER TABLE users ADD COLUMN invitation_code TEXT`);
    console.log('Added users.invitation_code');
}
if (!inviteUserColumns.includes('referred_by')) {
    db.exec(`ALTER TABLE users ADD COLUMN referred_by INTEGER`);
    console.log('Added users.referred_by');
}
if (!inviteUserColumns.includes('total_referrals')) {
    db.exec(`ALTER TABLE users ADD COLUMN total_referrals INTEGER NOT NULL DEFAULT 0`);
    console.log('Added users.total_referrals');
}



/* ========================================
   USERS MIGRATION
======================================== */

let userColumns = getColumns("users");


if (!userColumns.includes("password_hash")) {

    db.exec(`
        ALTER TABLE users
        ADD COLUMN password_hash TEXT
    `);

    console.log(
        "Added users.password_hash"
    );
}


/* verified */

userColumns = getColumns("users");

if (!userColumns.includes("verified")) {

    db.exec(`
        ALTER TABLE users
        ADD COLUMN verified INTEGER NOT NULL DEFAULT 0
    `);

    console.log(
        "Added users.verified"
    );
}


/* status */

userColumns = getColumns("users");

if (!userColumns.includes("status")) {

    db.exec(`
        ALTER TABLE users
        ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    `);

    console.log(
        "Added users.status"
    );
}


/* last_ip */

userColumns = getColumns("users");

if (!userColumns.includes("last_ip")) {

    db.exec(`
        ALTER TABLE users
        ADD COLUMN last_ip TEXT
    `);

    console.log(
        "Added users.last_ip"
    );
}


/* last_device */

userColumns = getColumns("users");

if (!userColumns.includes("last_device")) {

    db.exec(`
        ALTER TABLE users
        ADD COLUMN last_device TEXT
    `);

    console.log(
        "Added users.last_device"
    );
}


/* last_login */

userColumns = getColumns("users");

if (!userColumns.includes("last_login")) {

    db.exec(`
        ALTER TABLE users
        ADD COLUMN last_login TEXT
    `);

    console.log(
        "Added users.last_login"
    );
}


/* ========================================
   OLD PASSWORD MIGRATION
======================================== */

userColumns = getColumns("users");

if (
    userColumns.includes("password") &&
    userColumns.includes("password_hash")
) {

    db.exec(`
        UPDATE users
        SET password_hash = password
        WHERE
            (password_hash IS NULL OR password_hash = '')
            AND password IS NOT NULL
    `);

    console.log(
        "Migrated old passwords to password_hash"
    );
}


/* ========================================
   FINAL DATABASE CHECK
======================================== */

console.log("");
console.log("=================================");
console.log("TTPRO DATABASE READY");
console.log("=================================");
console.log("Users:", db
    .prepare("SELECT COUNT(*) AS count FROM users")
    .get()
    .count
);

console.log("Admins:", db
    .prepare("SELECT COUNT(*) AS count FROM admins")
    .get()
    .count
);

console.log("Login History:", db
    .prepare("SELECT COUNT(*) AS count FROM login_history")
    .get()
    .count
);

console.log("=================================");
console.log("");


module.exports = db;
