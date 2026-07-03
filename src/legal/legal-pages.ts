/**
 * Public legal pages — static HTML served directly from the Worker (Twilio A2P 10DLC).
 * Inline CSS only; no external dependencies.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageShell(title: string, subtitle: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Columbus Home Solutions</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 17px;
      line-height: 1.65;
      color: #1a1a1a;
      background: #fff;
    }
    .wrap {
      max-width: 720px;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
    }
    header {
      border-bottom: 1px solid #e5e5e5;
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
    }
    .brand {
      font-size: 0.875rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #555;
      margin: 0 0 0.5rem;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin: 0 0 0.25rem;
      line-height: 1.25;
    }
    .updated {
      font-size: 0.9375rem;
      color: #666;
      margin: 0;
    }
    h2 {
      font-size: 1.125rem;
      font-weight: 700;
      margin: 2rem 0 0.75rem;
      color: #111;
    }
    p { margin: 0 0 1rem; }
    ul {
      margin: 0 0 1rem;
      padding-left: 1.35rem;
    }
    li { margin-bottom: 0.35rem; }
    footer {
      margin-top: 3rem;
      padding-top: 1.5rem;
      border-top: 1px solid #e5e5e5;
      font-size: 0.9375rem;
      color: #444;
    }
    footer p { margin: 0 0 0.35rem; }
    a { color: #1a5276; }
    @media (max-width: 480px) {
      body { font-size: 16px; }
      .wrap { padding: 1.5rem 1rem 2.5rem; }
      h1 { font-size: 1.5rem; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <p class="brand">Columbus Home Solutions</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="updated">${escapeHtml(subtitle)}</p>
    </header>
    <main>
      ${bodyHtml}
    </main>
    <footer>
      <p><strong>Columbus Home Solutions</strong></p>
      <p>4414 N Olive St, North Little Rock, AR 72116</p>
      <p><a href="mailto:tony@homesolutionsar.com">tony@homesolutionsar.com</a> · (501) 263-2050 · homesolutionsar.com</p>
    </footer>
  </div>
</body>
</html>`;
}

export const PRIVACY_POLICY_HTML = pageShell(
  "Privacy Policy",
  "Last updated: June 21, 2026",
  `<p>Columbus Home Solutions ("we," "us," or "our") operates at homesolutionsar.com and provides residential remodeling and construction services. This Privacy Policy explains how we collect, use, and protect your personal information when you use our website, request our services, or communicate with us.</p>

<h2>1. Information We Collect</h2>
<p><strong>Information you provide directly:</strong></p>
<ul>
  <li>Full name, phone number, email address, and property address when you submit a service request or contact form</li>
  <li>Payment information (processed securely through Stripe; we do not store card numbers)</li>
  <li>Project details, photos, and communications you share with us</li>
  <li>Your signature when signing contracts electronically via BoldSign</li>
</ul>
<p><strong>Information collected automatically:</strong></p>
<ul>
  <li>Basic website usage data (pages visited, browser type) via standard web analytics</li>
  <li>IP address and device information</li>
</ul>
<p><strong>Information from third parties:</strong></p>
<ul>
  <li>Lead and referral information from Google Local Services and other advertising platforms</li>
</ul>

<h2>2. How We Use Your Information</h2>
<p>We use your information to:</p>
<ul>
  <li>Respond to service inquiries and schedule estimates</li>
  <li>Prepare and deliver project estimates, contracts, invoices, and receipts</li>
  <li>Send project-related text messages and emails (appointment reminders, status updates, payment confirmations)</li>
  <li>Process payments through Stripe</li>
  <li>Fulfill warranty obligations after project completion</li>
  <li>Comply with legal and regulatory requirements</li>
  <li>Improve our services</li>
</ul>

<h2>3. Text Message (SMS) Program</h2>
<p><strong>Program name:</strong> Columbus Home Solutions SMS Notifications</p>
<p>By providing your phone number and opting in, you agree to receive text messages from Columbus Home Solutions at the number provided, including:</p>
<ul>
  <li>Estimate appointment confirmations and reminders</li>
  <li>Project status updates</li>
  <li>Payment confirmations and receipts</li>
  <li>Job completion notifications</li>
  <li>Warranty-related communications</li>
</ul>
<p><strong>Message frequency:</strong> Varies based on your project activity. Typically 2–10 messages per project.</p>
<p>Message and data rates may apply. Standard carrier rates apply to all messages sent and received.</p>
<p><strong>To get help:</strong> Reply HELP to any message or email us at tony@homesolutionsar.com</p>
<p><strong>To opt out:</strong> Reply STOP to any message at any time. You will receive one confirmation message and no further texts will be sent. Opting out does not affect your ability to receive service.</p>
<p>We do not sell or share your phone number with third parties for marketing purposes. Text messaging originator opt-in data and consent will not be shared with any third parties or affiliates for marketing or promotional purposes. Your consent to receive SMS is not required as a condition of receiving our services.</p>

<h2>4. How We Share Your Information</h2>
<p>We do not sell your personal information. We may share it with:</p>
<ul>
  <li>Service providers who help us operate our business (Stripe for payments, Twilio for SMS, Resend for email, BoldSign for e-signatures, Cloudflare for hosting)</li>
  <li>Subcontractors involved in your specific project, limited to what is necessary to complete the work</li>
  <li>Legal authorities when required by law or to protect our rights</li>
</ul>
<p>All service providers are contractually required to protect your information and use it only for the purpose of providing services to us.</p>

<p>Mobile Information Sharing Exclusion: Notwithstanding anything else in this Privacy Policy, no mobile information or text messaging originator opt-in data and consent will be shared with third parties, affiliates, or subcontractors for marketing or promotional purposes. All the above categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.</p>

<h2>5. Data Retention</h2>
<p>We retain your information for as long as necessary to:</p>
<ul>
  <li>Fulfill your project and warranty obligations</li>
  <li>Comply with applicable tax, legal, and business record requirements (typically 7 years for financial records)</li>
  <li>Resolve disputes and enforce agreements</li>
</ul>
<p>SMS opt-out records are retained indefinitely to honor your preferences.</p>

<h2>6. Your Rights</h2>
<p>You may contact us at any time to:</p>
<ul>
  <li>Request access to the personal information we hold about you</li>
  <li>Request correction of inaccurate information</li>
  <li>Request deletion of your information (subject to legal retention requirements)</li>
  <li>Opt out of SMS communications by replying STOP</li>
</ul>
<p>To exercise these rights:<br>
tony@homesolutionsar.com · (501) 263-2050<br>
4414 N Olive St, North Little Rock, AR 72116</p>

<h2>7. Security</h2>
<p>We take reasonable technical and organizational measures to protect your information, including encrypted data transmission (HTTPS), access controls, and secure third-party payment processing. No method of transmission over the internet is 100% secure.</p>

<h2>8. Children's Privacy</h2>
<p>Our services are not directed to children under 13. We do not knowingly collect personal information from children under 13.</p>

<h2>9. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. The "Last updated" date at the top of this page reflects the most recent revision.</p>

<h2>10. Contact Us</h2>
<p>Columbus Home Solutions<br>
4414 N Olive St, North Little Rock, AR 72116<br>
tony@homesolutionsar.com · (501) 263-2050 · homesolutionsar.com</p>`,
);

export const TERMS_HTML = pageShell(
  "Terms and Conditions",
  "Last updated: June 21, 2026",
  `<p>These Terms and Conditions govern your use of the Columbus Home Solutions website at homesolutionsar.com, the client portal at client.homesolutionsar.com, and our services. By using our website or engaging our services, you agree to these terms.</p>

<h2>1. Services</h2>
<p>Columbus Home Solutions provides residential remodeling and construction services in the North Little Rock, Arkansas area. All services are subject to a separate written contract signed by both parties prior to work beginning.</p>

<h2>2. Website Use</h2>
<p>You agree to use our website only for lawful purposes. You may not submit false or misleading information, attempt to gain unauthorized access to any part of our systems, or use automated tools to scrape or extract data from our website.</p>

<h2>3. Estimate Requests</h2>
<p>Submitting an estimate request does not create a contract or obligation on either party. An estimate is not a guarantee of final project cost. Work begins only after a written contract is signed and a deposit is received.</p>

<h2>4. Client Portal</h2>
<p>Access to the client portal at client.homesolutionsar.com is provided via a secure link tied to your specific project. You are responsible for keeping your portal link confidential. Portal access does not expire, allowing you to reference project documents, photos, and warranty information at any time.</p>

<h2>5. Payments</h2>
<p>Payments are processed securely through Stripe. A convenience fee of 3.5% applies to credit and debit card payments made through the client portal. Payments by check carry no additional fee. Payment schedules are defined in your project contract.</p>

<h2>6. SMS Communications Program</h2>
<p><strong>Program name:</strong> Columbus Home Solutions SMS Notifications<br>
<strong>Sending number:</strong> (501) 263-2050</p>
<p>By providing your phone number and opting in on our contact or estimate request form, you consent to receive text messages from Columbus Home Solutions, including:</p>
<ul>
  <li>Estimate appointment confirmations and reminders</li>
  <li>Project status updates and scheduling notifications</li>
  <li>Payment confirmations and receipts</li>
  <li>Job completion and warranty notifications</li>
</ul>
<p><strong>Message frequency:</strong> Varies based on project activity. Typically 2–10 messages per project.</p>
<p>Message and data rates may apply. Standard carrier rates apply.</p>
<p><strong>To get help:</strong> Reply HELP to any message or contact us at tony@homesolutionsar.com</p>
<p><strong>To opt out:</strong> Reply STOP to any message at any time. You will receive one confirmation and no further messages will be sent. Opting out does not affect your ability to receive our services.</p>
<p>Consent to receive SMS messages is not required as a condition of purchasing or receiving services from Columbus Home Solutions.</p>

<h2>7. Intellectual Property</h2>
<p>All content on this website — including text, photos, logos, and project images — is owned by Columbus Home Solutions and may not be reproduced, distributed, or used without written permission.</p>

<h2>8. Limitation of Liability</h2>
<p>To the maximum extent permitted by applicable law, Columbus Home Solutions shall not be liable for any indirect, incidental, or consequential damages arising from your use of this website or our services beyond what is covered by the terms of your signed project contract.</p>

<h2>9. Governing Law</h2>
<p>These Terms are governed by the laws of the State of Arkansas. Any disputes arising under these Terms shall be resolved in the courts of Pulaski County, Arkansas.</p>

<h2>10. Changes to These Terms</h2>
<p>We may update these Terms from time to time. The "Last updated" date at the top reflects the most recent revision. Continued use of our website or services constitutes acceptance of the updated Terms.</p>

<h2>11. Contact Us</h2>
<p>Columbus Home Solutions<br>
4414 N Olive St, North Little Rock, AR 72116<br>
tony@homesolutionsar.com · (501) 263-2050 · homesolutionsar.com</p>`,
);

export function legalPageResponse(html: string, method = "GET"): Response {
  return new Response(method === "HEAD" ? null : html, {
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
