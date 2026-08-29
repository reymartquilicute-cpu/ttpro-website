require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const crypto = require("node:crypto");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

/* ========================================
   MIDDLEWARE
======================================== */

app.use(express.json());

app.use(
    session({
        secret:
            process.env.SESSION_SECRET ||
            "ttpro-" + Math.random().toString(36),

        resave: false,
        saveUninitialized: false,

        cookie: {
            httpOnly: true,
            secure: false,
            maxAge: 30 * 60 * 1000
        }
    })
);

/* Page routes — registered BEFORE static middleware */
app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);


/* ========================================
   HELPERS
======================================== */

function generateOTP() {
    return Math.floor(
        100000 + Math.random() * 900000
    ).toString();
}


function normalizePhone(country, number) {
    let clean = String(number)
        .replace(/\D/g, "");

    if (country === "+63") {
        if (clean.startsWith("63")) {
            clean = clean.substring(2);
        }

        if (clean.startsWith("0")) {
            clean = clean.substring(1);
        }

        return "+63" + clean;
    }

    return country + clean;
}


function hashPassword(password) {
    return crypto
        .createHash("sha256")
        .update(password)
        .digest("hex");
}


function getClientIP(req) {
    return (
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        ""
    );
}


/* ========================================
   REGISTER
======================================== */

app.post("/api/register", (req, res) => {
    try {
        const {
            name,
            country,
            phone,
            password
        } = req.body;

        if (
            !name ||
            !country ||
            !phone ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                message: "All fields are required."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message:
                    "Password must be at least 6 characters."
            });
        }

        const fullPhone =
            normalizePhone(country, phone);

        if (!/^\+\d{10,15}$/.test(fullPhone)) {
            return res.status(400).json({
                success: false,
                message: "Invalid phone number."
            });
        }

        const existingUser = db
            .prepare(
                "SELECT id FROM users WHERE phone = ?"
            )
            .get(fullPhone);

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message:
                    "This phone number is already registered."
            });
        }

        const otp = generateOTP();

        // Validate invite code if provided
        let inviteOwnerId = null;
        const inviteCodeRaw = (req.body.invite_code || "").trim().toUpperCase();
        if (inviteCodeRaw) {
            const inviteOwner = db
                .prepare("SELECT id FROM users WHERE invitation_code = ?")
                .get(inviteCodeRaw);
            if (inviteOwner) {
                inviteOwnerId = inviteOwner.id;
            }
        }

        req.session.pendingRegistration = {
            name,
            phone: fullPhone,
            password: hashPassword(password),
            otpHash: hashPassword(otp),
            expiresAt:
                Date.now() + 5 * 60 * 1000,
            attempts: 0,
            inviteOwnerId,
            inviteCode: inviteCodeRaw || null
        };

        console.log("");
        console.log("=================================");
        console.log("TTPRO DEVELOPMENT OTP");
        console.log("Phone:", fullPhone);
        console.log("OTP:", otp);
        console.log("Expires: 5 minutes");
        console.log("=================================");
        console.log("");

        res.json({
            success: true,
            phone: fullPhone,
            message:
                "Verification code generated.",
            developmentOtp: otp
        });

    } catch (error) {
        console.error(
            "REGISTER ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to register."
        });
    }
});


/* ========================================
   VERIFY OTP
======================================== */

app.post("/api/verify", (req, res) => {
    try {
        const { code } = req.body;

        const pending =
            req.session.pendingRegistration;

        if (!pending) {
            return res.status(400).json({
                success: false,
                message:
                    "No pending verification."
            });
        }

        if (Date.now() > pending.expiresAt) {
            delete req.session
                .pendingRegistration;

            return res.status(400).json({
                success: false,
                message:
                    "Verification code expired."
            });
        }

        if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({
                success: false,
                message:
                    "Enter a valid 6-digit code."
            });
        }

        pending.attempts++;

        if (pending.attempts > 5) {
            delete req.session
                .pendingRegistration;

            return res.status(429).json({
                success: false,
                message:
                    "Too many attempts."
            });
        }

        if (
            hashPassword(code) !==
            pending.otpHash
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Incorrect verification code."
            });
        }

        const now = new Date().toISOString();

        const result = db
    .prepare(`
        INSERT INTO users
        (
            name,
            phone,
            password_hash,
            verified,
            status,
            referred_by,
            created_at
        )
        VALUES (?, ?, ?, 1, 'active', ?, ?)
    `)
    .run(
        pending.name,
        pending.phone,
        pending.password,
        pending.inviteOwnerId || null,
        now
    );

        const newUserId = Number(result.lastInsertRowid);

        // ── Invite code reward: ₱2 to new user + ₱2 to referrer ──
        if (pending.inviteOwnerId) {
            const REWARD = 2;

            // Credit new user ₱2
            db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
                .run(REWARD, newUserId);

            // Notify new user
            db.prepare(`
                INSERT INTO notifications (user_id, title, message, is_read, created_at)
                VALUES (?, ?, ?, 0, ?)
            `).run(
                newUserId,
                "🎁 Welcome Bonus!",
                `You used an invitation code and received a ₱${REWARD}.00 welcome bonus! It has been added to your balance.`,
                now
            );

            // Credit referrer ₱2
            db.prepare("UPDATE users SET balance = balance + ?, total_referrals = total_referrals + 1 WHERE id = ?")
                .run(REWARD, pending.inviteOwnerId);

            // Notify referrer
            db.prepare(`
                INSERT INTO notifications (user_id, title, message, is_read, created_at)
                VALUES (?, ?, ?, 0, ?)
            `).run(
                pending.inviteOwnerId,
                "🎉 Referral Bonus!",
                `${pending.name} joined using your invitation code! You received a ₱${REWARD}.00 referral bonus.`,
                now
            );

            console.log(`[INVITE] ₱${REWARD} credited to new user #${newUserId} and referrer #${pending.inviteOwnerId}`);
        }

        req.session.user = {
            id: newUserId,
            name: pending.name,
            phone: pending.phone
        };

        delete req.session
            .pendingRegistration;

        res.json({
            success: true,
            message:
                "Account created successfully.",
            user: req.session.user
        });

    } catch (error) {
        console.error(
            "VERIFY ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Verification failed."
        });
    }
});


/* ========================================
   RESEND OTP
======================================== */

app.post("/api/resend", (req, res) => {
    try {
        const pending =
            req.session.pendingRegistration;

        if (!pending) {
            return res.status(400).json({
                success: false,
                message:
                    "No pending registration."
            });
        }

        const otp = generateOTP();

        pending.otpHash =
            hashPassword(otp);

        pending.expiresAt =
            Date.now() + 5 * 60 * 1000;

        pending.attempts = 0;

        console.log("");
        console.log("=================================");
        console.log("NEW TTPRO OTP");
        console.log("Phone:", pending.phone);
        console.log("OTP:", otp);
        console.log("Expires: 5 minutes");
        console.log("=================================");
        console.log("");

        res.json({
            success: true,
            message:
                "New verification code generated.",
            developmentOtp: otp
        });

    } catch (error) {
        console.error(
            "RESEND ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to resend OTP."
        });
    }
});


/* ========================================
   LOGIN
======================================== */

/* ========================================
   LOGIN
======================================== */

app.post("/api/login", (req, res) => {
    try {
        const {
            phone,
            password
        } = req.body;

        if (!phone || !password) {
            return res.status(400).json({
                success: false,
                message:
                    "Phone number and password are required."
            });
        }

        const normalizedPhone =
            normalizePhone("+63", phone);

        const user = db
            .prepare(`
                SELECT *
                FROM users
                WHERE phone = ?
            `)
            .get(normalizedPhone);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Account not found."
            });
        }

        // Check if account is frozen
        if (user.status === "frozen") {
            return res.status(403).json({
                success: false,
                message: "This account is frozen."
            });
        }

        // Check password
        if (
            user.password_hash !==
            hashPassword(password)
        ) {
            saveLoginHistory(
                user.id,
                false,
                req
            );

            return res.status(401).json({
                success: false,
                message: "Incorrect password."
            });
        }

        // Check verification
        if (!user.verified) {
            return res.status(403).json({
                success: false,
                message:
                    "Phone number is not verified."
            });
        }

        // Get IP address
        const ip = getClientIP(req);

        // Get browser/device information
        const device =
            req.headers["user-agent"] || "Unknown";

        const loginTime =
            new Date().toISOString();

        // Save login information
        db.prepare(`
            UPDATE users
            SET
                last_ip = ?,
                last_device = ?,
                last_login = ?
            WHERE id = ?
        `).run(
            ip,
            device,
            loginTime,
            user.id
        );

        // Save successful login
        saveLoginHistory(
            user.id,
            true,
            req
        );

        // Create session
        req.session.user = {
            id: user.id,
            name: user.name,
            phone: user.phone
        };

        res.json({
            success: true,
            message: "Login successful.",
            user: req.session.user
        });

    } catch (error) {
        console.error(
            "LOGIN ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Login failed."
        });
    }
});


/* ========================================
   LOGIN HISTORY
======================================== */

function saveLoginHistory(
    userId,
    success,
    req
) {
    try {
        db.prepare(`
            INSERT INTO login_history
            (
                user_id,
                success,
                ip_address,
                user_agent,
                created_at
            )
            VALUES (?, ?, ?, ?, ?)
        `).run(
            userId,
            success ? 1 : 0,
            getClientIP(req),
            req.headers["user-agent"] || "",
            new Date().toISOString()
        );
    } catch (error) {
        console.error(
            "LOGIN HISTORY ERROR:",
            error
        );
    }
}


/* ========================================
   CURRENT USER
======================================== */

app.get("/api/me", (req, res) => {

    if (!req.session.user) {
        return res.json({
            loggedIn: false
        });
    }

    res.json({
        loggedIn: true,
        user: req.session.user
    });
});


/* ========================================
   LOGOUT
======================================== */

app.post("/api/logout", (req, res) => {

    req.session.destroy(error => {

        if (error) {
            return res.status(500).json({
                success: false,
                message:
                    "Logout failed."
            });
        }

        res.json({
            success: true
        });
    });
});


/* ========================================
   USER DASHBOARD
======================================== */

function requireUser(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({
            success: false,
            message: "Login required."
        });
    }
    next();
}

app.get("/api/dashboard", requireUser, (req, res) => {
    try {
        const userId = req.session.user.id;
        const user = db.prepare(`
            SELECT id, name, phone, balance, verified, status, created_at, invitation_code, total_referrals
            FROM users WHERE id = ?
        `).get(userId);

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        // Auto-generate invitation code
        if (!user.invitation_code) {
            const code = "TT" + Math.random().toString(36).substring(2, 8).toUpperCase();
            db.prepare("UPDATE users SET invitation_code = ? WHERE id = ?").run(code, userId);
            user.invitation_code = code;
        }

        const history = db.prepare(`
            SELECT id, reference, amount, status, created_at
            FROM settlements
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 20
        `).all(userId);

        const notifications = db.prepare(`
            SELECT id, title, message, is_read, created_at
            FROM notifications
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 20
        `).all(userId);

        const recentWithdrawals = db.prepare(`
            SELECT id, amount, account_name, bank_name, status, created_at
            FROM withdrawals WHERE user_id = ?
            ORDER BY id DESC LIMIT 5
        `).all(userId);

        const totalSettlements = db.prepare(`
            SELECT COUNT(*) AS count FROM settlements WHERE user_id = ?
        `).get(userId).count;

        const unreadNotifications = db.prepare(`
            SELECT COUNT(*) AS count FROM notifications
            WHERE user_id = ? AND is_read = 0
        `).get(userId).count;

        const totalWithdrawals = db.prepare(`
            SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE user_id = ? AND status != 'Rejected'
        `).get(userId).total;

        res.json({
            success: true,
            user,
            balance: user.balance || 0,
            totalSettlements,
            unreadNotifications,
            totalWithdrawals,
            invitation_code: user.invitation_code,
            total_referrals: user.total_referrals || 0,
            history,
            notifications,
            recentWithdrawals
        });
    } catch (error) {
        console.error("DASHBOARD ERROR:", error);
        res.status(500).json({ success: false, message: "Unable to load dashboard." });
    }
});

app.get("/api/history", requireUser, (req, res) => {
    try {
        const history = db.prepare(`
            SELECT id, reference, amount, status, created_at
            FROM settlements WHERE user_id = ?
            ORDER BY id DESC
        `).all(req.session.user.id);
        res.json({ success: true, history });
    } catch (error) {
        console.error("HISTORY ERROR:", error);
        res.status(500).json({ success: false, message: "Unable to load settlement history." });
    }
});

app.get("/api/notifications", requireUser, (req, res) => {
    try {
        const notifications = db.prepare(`
            SELECT id, title, message, is_read, created_at
            FROM notifications WHERE user_id = ?
            ORDER BY id DESC
        `).all(req.session.user.id);

        db.prepare(`
            UPDATE notifications SET is_read = 1
            WHERE user_id = ?
        `).run(req.session.user.id);

        res.json({ success: true, notifications });
    } catch (error) {
        console.error("NOTIFICATIONS ERROR:", error);
        res.status(500).json({ success: false, message: "Unable to load notifications." });
    }
});

app.get("/api/profile", requireUser, (req, res) => {
    try {
        const user = db.prepare(`
            SELECT id, name, phone, balance, verified, status, last_ip, last_device, last_login, created_at,
                   invitation_code, total_referrals
            FROM users WHERE id = ?
        `).get(req.session.user.id);

        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        res.json({ success: true, user });
    } catch (error) {
        console.error("PROFILE ERROR:", error);
        res.status(500).json({ success: false, message: "Unable to load profile." });
    }
});

/* ========================================
   INVITATION CODE
======================================== */

app.get("/api/invite", requireUser, (req, res) => {
    try {
        const userId = req.session.user.id;
        let user = db.prepare(
            "SELECT id, name, invitation_code, total_referrals FROM users WHERE id = ?"
        ).get(userId);

        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        // Auto-generate invitation code if user doesn't have one
        if (!user.invitation_code) {
            const code = "TT" + Math.random().toString(36).substring(2, 8).toUpperCase();
            db.prepare("UPDATE users SET invitation_code = ? WHERE id = ?").run(code, userId);
            user.invitation_code = code;
        }

        // Get people who used this invitation code
        const referrals = db.prepare(`
            SELECT name, phone, created_at
            FROM users WHERE referred_by = ?
            ORDER BY id DESC LIMIT 20
        `).all(userId);

        res.json({
            success: true,
            invitation_code: user.invitation_code,
            total_referrals: user.total_referrals || referrals.length,
            referrals
        });
    } catch (error) {
        console.error("INVITE ERROR:", error);
        res.status(500).json({ success: false, message: "Unable to load invitation info." });
    }
});

/* ========================================
   WITHDRAWAL
======================================== */

app.post("/api/withdraw", requireUser, (req, res) => {
    try {
        const userId = req.session.user.id;
        const { amount, account_name, account_number, bank_name } = req.body;

        if (!amount || !account_name || !account_number || !bank_name) {
            return res.status(400).json({ success: false, message: "All fields are required." });
        }

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({ success: false, message: "Enter a valid amount." });
        }

        if (parsedAmount < 100) {
            return res.status(400).json({ success: false, message: "Minimum withdrawal is ₱100." });
        }

        const user = db.prepare("SELECT balance FROM users WHERE id = ?").get(userId);
        if (!user || user.balance < parsedAmount) {
            return res.status(400).json({ success: false, message: "Insufficient balance." });
        }

        // Deduct balance and create withdrawal record
        db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(parsedAmount, userId);

        const now = new Date().toISOString();
        const result = db.prepare(`
            INSERT INTO withdrawals (user_id, amount, account_name, account_number, bank_name, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'Pending', ?)
        `).run(userId, parsedAmount, account_name, account_number, bank_name, now);

        res.json({
            success: true,
            message: "Withdrawal request submitted.",
            withdrawal_id: result.lastInsertRowid
        });
    } catch (error) {
        console.error("WITHDRAW ERROR:", error);
        res.status(500).json({ success: false, message: "Unable to process withdrawal." });
    }
});

app.get("/api/withdrawals", requireUser, (req, res) => {
    try {
        const withdrawals = db.prepare(`
            SELECT id, amount, account_name, account_number, bank_name, status, note, created_at
            FROM withdrawals WHERE user_id = ?
            ORDER BY id DESC LIMIT 50
        `).all(req.session.user.id);
        res.json({ success: true, withdrawals });
    } catch (error) {
        console.error("WITHDRAWALS ERROR:", error);
        res.status(500).json({ success: false, message: "Unable to load withdrawals." });
    }
});

/* ========================================
   ADMIN AUTH
======================================== */

function requireAdmin(req, res, next) {

    if (!req.session.admin) {
        return res.status(401).json({
            success: false,
            message:
                "Admin authentication required."
        });
    }

    next();
}


app.post(
    "/api/admin/login",
    (req, res) => {

        try {

            const {
                username,
                password
            } = req.body;

            const admin = db
                .prepare(`
                    SELECT *
                    FROM admins
                    WHERE username = ?
                `)
                .get(username);

            if (!admin) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid admin credentials."
                });
            }

            const passwordHash =
                hashPassword(password);

            if (
                passwordHash !==
                admin.password_hash
            ) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid admin credentials."
                });
            }

            req.session.admin = {
                id: admin.id,
                username: admin.username
            };

            res.json({
                success: true,
                message:
                    "Admin login successful."
            });

        } catch (error) {

            console.error(
                "ADMIN LOGIN ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Admin login failed."
            });
        }
    }
);


/* ========================================
   ADMIN LOGOUT
======================================== */

app.post(
    "/api/admin/logout",
    requireAdmin,
    (req, res) => {

        delete req.session.admin;

        res.json({
            success: true
        });
    }
);


/* ========================================
   ADMIN USERS
======================================== */

app.get(
    "/api/admin/users",
    requireAdmin,
    (req, res) => {

        try {

            const users = db
                .prepare(`
                    SELECT
                        id,
                        name,
                        phone,
                        balance,
                        verified,
                        status,
                        last_ip,
                        last_device,
                        last_login,
                        invitation_code,
                        total_referrals,
                        created_at
                    FROM users
                    ORDER BY id DESC
                `)
                .all();

            res.json({
                success: true,
                users
            });

        } catch (error) {

            console.error(
                "ADMIN USERS ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load users."
            });
        }
    }
);


/* ========================================
   ADMIN USER DETAILS
======================================== */

app.get(
    "/api/admin/users/:id",
    requireAdmin,
    (req, res) => {

        try {

            const user = db
                .prepare(`
                    SELECT
                        id,
                        name,
                        phone,
                        balance,
                        verified,
                        status,
                        last_ip,
                        last_device,
                        last_login,
                        invitation_code,
                        total_referrals,
                        created_at
                    FROM users
                    WHERE id = ?
                `)
                .get(req.params.id);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message:
                        "User not found."
                });
            }

            const loginHistory = db
                .prepare(`
                    SELECT
                        id,
                        success,
                        ip_address,
                        user_agent,
                        created_at
                    FROM login_history
                    WHERE user_id = ?
                    ORDER BY id DESC
                    LIMIT 50
                `)
                .all(req.params.id);

            res.json({
                success: true,
                user,
                loginHistory
            });

        } catch (error) {

            console.error(
                "USER DETAILS ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load user."
            });
        }
    }
);


/* ========================================
   FREEZE ACCOUNT
======================================== */

app.post(
    "/api/admin/users/:id/freeze",
    requireAdmin,
    (req, res) => {

        try {

            const result = db
                .prepare(`
                    UPDATE users
                    SET status = 'frozen'
                    WHERE id = ?
                `)
                .run(req.params.id);

            if (result.changes === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        "User not found."
                });
            }

            res.json({
                success: true,
                message:
                    "Account frozen."
            });

        } catch (error) {

            console.error(
                "FREEZE ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to freeze account."
            });
        }
    }
);


/* ========================================
   UNFREEZE ACCOUNT
======================================== */

app.post(
    "/api/admin/users/:id/unfreeze",
    requireAdmin,
    (req, res) => {

        try {

            const result = db
                .prepare(`
                    UPDATE users
                    SET status = 'active'
                    WHERE id = ?
                `)
                .run(req.params.id);

            if (result.changes === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        "User not found."
                });
            }

            res.json({
                success: true,
                message:
                    "Account unfrozen."
            });

        } catch (error) {

            console.error(
                "UNFREEZE ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to unfreeze account."
            });
        }
    }
);


app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ========================================
   ADMIN — CHECK SESSION
======================================== */

app.get("/api/admin/me", (req, res) => {
    if (!req.session.admin) {
        return res.json({ loggedIn: false });
    }
    res.json({ loggedIn: true, admin: req.session.admin });
});

/* ========================================
   ADMIN — ADD CASH
======================================== */

app.post(
    "/api/admin/users/:id/add-cash",
    requireAdmin,
    (req, res) => {
        try {
            const userId = req.params.id;
            const { amount, note } = req.body;

            const parsed = parseFloat(amount);
            if (!parsed || parsed <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Enter a valid amount."
                });
            }

            const user = db
                .prepare("SELECT id, name, balance FROM users WHERE id = ?")
                .get(userId);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: "User not found."
                });
            }

            db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
                .run(parsed, userId);

            const newBalance = (user.balance || 0) + parsed;

            // Save a notification for the user
            db.prepare(`
                INSERT INTO notifications (user_id, title, message, is_read, created_at)
                VALUES (?, ?, ?, 0, ?)
            `).run(
                userId,
                "Cash Added to Your Account",
                `₱${parsed.toLocaleString("en-PH", { minimumFractionDigits: 2 })} has been added to your account${note ? `: ${note}` : "."}`,
                new Date().toISOString()
            );

            console.log(`[ADMIN] Added ₱${parsed} to user #${userId} (${user.name}). New balance: ₱${newBalance}`);

            res.json({
                success: true,
                message: `Successfully added ₱${parsed} to ${user.name}.`,
                newBalance
            });

        } catch (error) {
            console.error("ADD CASH ERROR:", error);
            res.status(500).json({
                success: false,
                message: "Unable to add cash."
            });
        }
    }
);

/* ========================================
   ADMIN — ALL WITHDRAWALS
======================================== */

app.get(
    "/api/admin/withdrawals",
    requireAdmin,
    (req, res) => {
        try {
            const withdrawals = db.prepare(`
                SELECT w.*, u.name AS user_name
                FROM withdrawals w
                LEFT JOIN users u ON u.id = w.user_id
                ORDER BY w.id DESC
            `).all();

            res.json({ success: true, withdrawals });
        } catch (error) {
            console.error("ADMIN WITHDRAWALS ERROR:", error);
            res.status(500).json({
                success: false,
                message: "Unable to load withdrawals."
            });
        }
    }
);

/* ========================================
   ADMIN — UPDATE WITHDRAWAL STATUS
======================================== */

app.post(
    "/api/admin/withdrawals/:id/status",
    requireAdmin,
    (req, res) => {
        try {
            const { status } = req.body;
            const allowed = ["Approved", "Rejected", "Pending"];

            if (!allowed.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid status."
                });
            }

            const withdrawal = db
                .prepare("SELECT * FROM withdrawals WHERE id = ?")
                .get(req.params.id);

            if (!withdrawal) {
                return res.status(404).json({
                    success: false,
                    message: "Withdrawal not found."
                });
            }

            // If rejecting a pending withdrawal, refund the balance
            if (status === "Rejected" && withdrawal.status === "Pending") {
                db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
                    .run(withdrawal.amount, withdrawal.user_id);

                db.prepare(`
                    INSERT INTO notifications (user_id, title, message, is_read, created_at)
                    VALUES (?, ?, ?, 0, ?)
                `).run(
                    withdrawal.user_id,
                    "Withdrawal Request Rejected",
                    `Your withdrawal of ₱${Number(withdrawal.amount).toLocaleString("en-PH", { minimumFractionDigits: 2 })} has been rejected. The amount has been refunded to your balance.`,
                    new Date().toISOString()
                );
            }

            // If approving, send approval notification
            if (status === "Approved" && withdrawal.status === "Pending") {
                db.prepare(`
                    INSERT INTO notifications (user_id, title, message, is_read, created_at)
                    VALUES (?, ?, ?, 0, ?)
                `).run(
                    withdrawal.user_id,
                    "Withdrawal Approved",
                    `Your withdrawal of ₱${Number(withdrawal.amount).toLocaleString("en-PH", { minimumFractionDigits: 2 })} to ${withdrawal.bank_name} has been approved.`,
                    new Date().toISOString()
                );
            }

            db.prepare("UPDATE withdrawals SET status = ? WHERE id = ?")
                .run(status, req.params.id);

            res.json({ success: true, message: `Withdrawal ${status.toLowerCase()}.` });

        } catch (error) {
            console.error("WITHDRAWAL STATUS ERROR:", error);
            res.status(500).json({
                success: false,
                message: "Unable to update withdrawal."
            });
        }
    }
);

/* ========================================
   ADMIN — SEND NOTIFICATION
======================================== */

app.post(
    "/api/admin/notify",
    requireAdmin,
    (req, res) => {
        try {
            const { userId, title, message } = req.body;

            if (!title || !message) {
                return res.status(400).json({
                    success: false,
                    message: "Title and message are required."
                });
            }

            const now = new Date().toISOString();

            if (userId === "all") {
                const users = db
                    .prepare("SELECT id FROM users WHERE status = 'active'")
                    .all();

                const insert = db.prepare(`
                    INSERT INTO notifications (user_id, title, message, is_read, created_at)
                    VALUES (?, ?, ?, 0, ?)
                `);

                const bulk = db.transaction((rows) => {
                    for (const u of rows) insert.run(u.id, title, message, now);
                });

                bulk(users);

                return res.json({
                    success: true,
                    message: `Notification sent to ${users.length} users.`
                });
            }

            const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    message: "User not found."
                });
            }

            db.prepare(`
                INSERT INTO notifications (user_id, title, message, is_read, created_at)
                VALUES (?, ?, ?, 0, ?)
            `).run(userId, title, message, now);

            res.json({ success: true, message: "Notification sent." });

        } catch (error) {
            console.error("NOTIFY ERROR:", error);
            res.status(500).json({
                success: false,
                message: "Unable to send notification."
            });
        }
    }
);

/* ========================================
   ADMIN — USER DETAILS (updated with balance)
======================================== */

/* ========================================
   START SERVER
======================================== */

app.listen(PORT, () => {

    console.log("");
    console.log("=================================");
    console.log(
        `TTPRO running on http://localhost:${PORT}`
    );
    console.log("OTP MODE: DEVELOPMENT");
    console.log("=================================");
    console.log("");
});
