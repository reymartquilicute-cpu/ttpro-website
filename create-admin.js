const crypto = require("node:crypto");
const db = require("./database");

const username = "reymart";
const password = "reyrey";

const passwordHash = crypto
    .createHash("sha256")
    .update(password)
    .digest("hex");

const existing = db
    .prepare(
        "SELECT id FROM admins WHERE username = ?"
    )
    .get(username);

if (existing) {

    db.prepare(`
        UPDATE admins
        SET password_hash = ?
        WHERE username = ?
    `).run(
        passwordHash,
        username
    );

    console.log("Admin password updated.");

} else {

    db.prepare(`
        INSERT INTO admins
        (
            username,
            password_hash,
            created_at
        )
        VALUES (?, ?, ?)
    `).run(
        username,
        passwordHash,
        new Date().toISOString()
    );

    console.log("Admin account created.");
}

console.log("");
console.log("Username:", username);
console.log("Password:", password);
console.log("");
