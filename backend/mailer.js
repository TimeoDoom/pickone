// Envoi des e-mails (SMTP via nodemailer).
// Variables d'environnement : SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
// En local, si SMTP n'est pas configuré, le code est simplement affiché dans la console du serveur.
const nodemailer = require("nodemailer");

const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
function getTransporter() {
  if (!transporter) {
    const port = parseInt(process.env.SMTP_PORT, 10) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendVerificationCode(to, username, code, minutes) {
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMTP non configuré (SMTP_HOST / SMTP_USER / SMTP_PASS).");
    }
    console.log(`\n✉  [DEV] Code de vérification pour ${to} : ${code}\n`);
    return;
  }
  const safeName = String(username).replace(/[&<>"']/g, "");
  await getTransporter().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: `${code} est votre code de vérification Pickone`,
    text:
      `Bonjour ${safeName},\n\nVotre code de vérification Pickone : ${code}\n` +
      `Il est valable ${minutes} minutes.\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto">` +
      `<h2>Bienvenue sur Pickone, ${safeName} !</h2>` +
      `<p>Votre code de vérification :</p>` +
      `<p style="font-size:34px;font-weight:bold;letter-spacing:8px;background:#f4f4f5;padding:14px;text-align:center;border-radius:10px">${code}</p>` +
      `<p style="color:#666">Il est valable ${minutes} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p></div>`,
  });
}

module.exports = { sendVerificationCode };
