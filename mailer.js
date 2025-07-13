// mailer.js
async function sendConfirmationEmail(booking) {
  const { Resend } = await import('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const { name, email, date, hours } = booking;

  const hoursText = hours.join(', ');
  const html = `
    <h2>Rezervace potvrzena – TopZkušebny</h2>
    <p>Dobrý den,</p>
    <p>Děkujeme za vaši rezervaci zkušebny. Zde je její shrnutí:</p>
    <ul>
      <li><strong>Datum:</strong> ${date}</li>
      <li><strong>Čas:</strong> ${hoursText}</li>
      <li><strong>Jméno:</strong> ${name}</li>
    </ul>
    <p>V případě změn nás kontaktujte na <a href="mailto:info@topzkusebny.cz">info@topzkusebny.cz</a>.</p>
    <p>Těšíme se na vás!<br/>TopZkušebny.cz</p>
  `;

  try {
    await resend.emails.send({
      from: 'TopZkušebny <onboarding@resend.dev>',
      to: email,
      subject: 'Rezervace potvrzena – TopZkušebny',
      html
    });
    console.log('📧 Confirmation email sent to', email);
  } catch (err) {
    console.error('❌ Email send error:', err);
  }
}

module.exports = sendConfirmationEmail;