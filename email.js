import nodemailer from 'nodemailer';

const publicUrl = (
  process.env.AURORA_PUBLIC_URL ||
  'https://snobbishly-bountiful-quail.cloudpub.ru'
).replace(/\/+$/, '');

export class EmailDeliveryError extends Error {
  constructor(diagnosticCode = 'smtp_failure') {
    super('Не удалось отправить письмо. Попробуйте ещё раз позже');
    this.name = 'EmailDeliveryError';
    this.code = 'email_delivery_failed';
    this.diagnosticCode = diagnosticCode;
  }
}

function getTransport() {
  if (process.env.NODE_ENV === 'test' && process.env.EMAIL_TEST_MODE === '1') {
    return {
      sendMail: async (message) => {
        if (process.env.EMAIL_TEST_FAIL === '1') throw new Error('Mock SMTP failure');
        return { accepted: [message.to], messageId: 'aurora-test-message' };
      },
      close() {},
    };
  }

  const host = process.env.EMAIL_SMTP_HOST;
  const user = process.env.EMAIL_SMTP_USER;
  const encodedPassword = process.env.EMAIL_SMTP_PASS_B64;
  const password = encodedPassword
    ? Buffer.from(encodedPassword, 'base64').toString('utf8')
    : process.env.EMAIL_SMTP_PASS;
  const port = Number(process.env.EMAIL_SMTP_PORT || 587);
  if (!host || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EmailDeliveryError('smtp_configuration_incomplete');
  }

  const secureValue = process.env.EMAIL_SMTP_SECURE?.trim().toLowerCase();
  const secureValues = new Map([
    ['true', true], ['1', true], ['yes', true], ['on', true],
    ['false', false], ['0', false], ['no', false], ['off', false],
  ]);
  if (secureValue && !secureValues.has(secureValue)) {
    throw new EmailDeliveryError('smtp_tls_setting_invalid');
  }
  const secure = secureValue ? secureValues.get(secureValue) : port === 465;
  if (port === 465 && !secure) throw new EmailDeliveryError('smtp_tls_port_mismatch');
  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user, pass: password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function template({ title, intro, content, note }) {
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f2fa;font-family:Arial,Helvetica,sans-serif;color:#211d35">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f2fa;padding:32px 12px">
<tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#fff;border-radius:22px;overflow:hidden">
<tr><td style="padding:28px 30px;background:linear-gradient(135deg,#6043d8,#426fe8);color:#fff">
<table role="presentation" cellspacing="0" cellpadding="0"><tr>
<td><img src="${escapeHtml(`${publicUrl}/assets/icons/app-icon-192.png`)}" width="42" height="42" alt="Aurora" style="display:block;border-radius:12px"></td>
<td style="padding-left:12px"><div style="font-size:12px;letter-spacing:3px;font-weight:bold">A U R O R A</div>
<div style="font-size:22px;font-weight:bold;margin-top:4px">Aurora Messenger</div></td>
</tr></table>
</td></tr>
<tr><td style="padding:30px"><h1 style="font-size:23px;line-height:1.3;margin:0 0 14px">${escapeHtml(title)}</h1>
<p style="font-size:15px;line-height:1.7;color:#5d5870;margin:0 0 22px">${escapeHtml(intro)}</p>
${content}<p style="font-size:13px;line-height:1.6;color:#777187;margin:24px 0 0">${escapeHtml(note)}</p>
</td></tr>
<tr><td style="padding:18px 30px;background:#faf9fd;border-top:1px solid #eeeaf7;color:#898399;font-size:12px;line-height:1.6">
Автоматическое письмо от Aurora Messenger. Не отвечайте на него.
</td></tr></table></td></tr></table></body></html>`;
}

async function send({ to, subject, text, html }) {
  let transporter;
  try {
    transporter = getTransport();
    const result = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER,
      to,
      subject,
      text,
      html,
    });
    if (!result.accepted?.length) throw new Error('SMTP did not accept the message');
    return result;
  } catch (error) {
    if (error instanceof EmailDeliveryError) throw error;
    const code = /^[A-Z0-9_-]{1,32}$/.test(String(error?.code || ''))
      ? String(error.code)
      : 'smtp_failure';
    throw new EmailDeliveryError(code);
  } finally {
    transporter?.close();
  }
}

export function sendVerificationEmail(to, code) {
  const html = template({
    title: 'Подтверждение электронной почты',
    intro: 'Введите этот код в Aurora Messenger, чтобы подтвердить адрес электронной почты.',
    content: `<div style="padding:22px 12px;background:#f4f0ff;border:1px solid #e4dcff;border-radius:16px;text-align:center">
<div style="font-size:12px;color:#71658f;margin-bottom:10px">КОД ПОДТВЕРЖДЕНИЯ</div>
<div style="font-size:35px;font-weight:bold;letter-spacing:8px;color:#6043d8">${escapeHtml(code)}</div></div>
<p style="font-size:14px;line-height:1.6;color:#5d5870">Код действует 10 минут. Никому не сообщайте его.</p>`,
    note: 'Если вы не создавали аккаунт и не запрашивали код, просто проигнорируйте это письмо.',
  });
  return send({
    to,
    subject: 'Код подтверждения — Aurora Messenger',
    text: `Код подтверждения Aurora: ${code}\nКод действует 10 минут. Никому не сообщайте его.\nЕсли вы не запрашивали код, проигнорируйте это письмо.`,
    html,
  });
}

export function sendEmailChangeNotice(to, newEmail) {
  const html = template({
    title: 'Изменён адрес электронной почты',
    intro: 'Для вашего аккаунта Aurora Messenger был запрошен новый адрес электронной почты.',
    content: `<p style="font-size:15px;line-height:1.7;color:#5d5870">Новый адрес: <strong>${escapeHtml(newEmail)}</strong>.</p>
<p style="font-size:14px;line-height:1.7;color:#5d5870">Если вы не меняли адрес, срочно смените пароль и завершите неизвестные сеансы в настройках безопасности.</p>`,
    note: 'Если это сделали вы, никаких действий не требуется.',
  });
  return send({
    to,
    subject: 'Изменён адрес аккаунта — Aurora Messenger',
    text: `Для вашего аккаунта Aurora Messenger был запрошен новый адрес: ${newEmail}.\nЕсли вы не меняли адрес, срочно смените пароль и завершите неизвестные сеансы в настройках безопасности.`,
    html,
  });
}

export function sendPasswordResetEmail(to, token) {
  const link = `${publicUrl}/#/reset?token=${encodeURIComponent(token)}`;
  const html = template({
    title: 'Сброс пароля',
    intro: 'Мы получили запрос на создание нового пароля для вашего аккаунта Aurora.',
    content: `<div style="text-align:center;padding:8px 0 4px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#6043d8;color:#fff;text-decoration:none;padding:15px 25px;border-radius:12px;font-weight:bold;font-size:15px">Создать новый пароль</a></div>
<p style="font-size:13px;line-height:1.7;color:#716b82;word-break:break-word">Если кнопка не открывается, скопируйте ссылку:<br><a href="${escapeHtml(link)}" style="color:#6043d8">${escapeHtml(link)}</a></p>`,
    note: 'Ссылка действует 1 час и используется один раз. Если вы не запрашивали сброс пароля, проигнорируйте это письмо.',
  });
  return send({
    to,
    subject: 'Сброс пароля — Aurora Messenger',
    text: `Чтобы создать новый пароль Aurora, откройте ссылку (действует 1 час):\n${link}\nЕсли вы не запрашивали сброс пароля, проигнорируйте это письмо.`,
    html,
  });
}
