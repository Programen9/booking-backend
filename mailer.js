// mailer.js

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendConfirmationEmail(booking) {
  const subject = `Potvrzení rezervace – ${booking.date}`;
  const htmlContent = `
    <h2>Potvrzení rezervace</h2>
    <p>Potvrzujeme Vaši rezervaci.</p>
    <p><strong>Datum:</strong> ${booking.date}</p>
    <p><strong>Hodiny:</strong> ${booking.hours.join(', ')}</p>
    <p><strong>Jméno:</strong> ${booking.name}</p>
    <p><strong>Email:</strong> ${booking.email}</p>
    <p><strong>Telefon:</strong> ${booking.phone}</p>
  `;

  try {
    // Send to customer
    await resend.emails.send({
      from: 'TopZkušebny <onboarding@resend.dev>',
      to: booking.email,
      subject,
      html: htmlContent,
    });

    // Send to internal address
    await resend.emails.send({
      from: 'TopZkušebny <onboarding@resend.dev>',
      to: 'info@topzkusebny.cz',
      subject: `Kopie potvrzení: ${subject}`,
      html: htmlContent,
    });

    console.log(`📧 Confirmation email sent to ${booking.email} and info@topzkusebny.cz`);
  } catch (error) {
    console.error('❌ Failed to send confirmation email:', error);
  }
}

module.exports = sendConfirmationEmail;