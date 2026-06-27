/**
 * generate-working-agreement-template.ts
 *
 * Builds src/templates/CHS-Working-Agreement-Template.docx with merge-field
 * placeholders. Run: npx tsx scripts/generate-working-agreement-template.ts
 * Then: npx tsx scripts/prep-templates.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} from "docx";

const BRAND_BLUE = "1B4F8C";
const BRAND_GOLD = "C9A227";
const OUT_PATH = path.join(process.cwd(), "src/templates/CHS-Working-Agreement-Template.docx");
const LOGO_PATH = path.join(process.cwd(), "frontend/src/assets/chs-logo.png");

function merge(text: string): TextRun {
  return new TextRun({ text, font: "Calibri", size: 22 });
}

function bold(text: string, color?: string): TextRun {
  return new TextRun({ text, bold: true, font: "Calibri", size: 22, color });
}

function bullet(text: string, boldParts?: string[]): Paragraph {
  let remaining = text;
  const runs: TextRun[] = [new TextRun({ text: "• ", font: "Calibri", size: 22 })];
  if (!boldParts?.length) {
    runs.push(merge(text));
    return new Paragraph({ children: runs, spacing: { after: 120 } });
  }
  for (const part of boldParts) {
    const idx = remaining.indexOf(part);
    if (idx > 0) runs.push(merge(remaining.slice(0, idx)));
    if (idx >= 0) {
      runs.push(bold(part));
      remaining = remaining.slice(idx + part.length);
    }
  }
  if (remaining) runs.push(merge(remaining));
  return new Paragraph({ children: runs, spacing: { after: 120 } });
}

function sectionTitle(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 160 },
    children: [
      new TextRun({ text, bold: true, font: "Calibri", size: 26, color: BRAND_BLUE }),
    ],
  });
}

function para(text: string, opts?: { spacingAfter?: number }): Paragraph {
  return new Paragraph({
    children: [merge(text)],
    spacing: { after: opts?.spacingAfter ?? 160 },
  });
}

async function main() {
  let logoBytes: Buffer | null = null;
  if (fs.existsSync(LOGO_PATH)) {
    logoBytes = fs.readFileSync(LOGO_PATH);
  } else {
    console.warn(`⚠ Logo not found at ${LOGO_PATH} — header will omit image`);
  }

  const headerChildren: Paragraph[] = [];
  if (logoBytes) {
    headerChildren.push(
      new Paragraph({
        children: [
          new ImageRun({
            data: logoBytes,
            transformation: { width: 80, height: 80 },
            type: "png",
          }),
        ],
      }),
    );
  }
  headerChildren.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({
          text: "Columbus Home Solutions, LLC",
          bold: true,
          color: BRAND_BLUE,
          font: "Calibri",
          size: 22,
        }),
      ],
    }),
  );

  const footer = new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: "right" as const, position: 9360 }],
        children: [
          new TextRun({
            text: "Columbus Home Solutions, LLC | (501) 263-2050 | tony@homesolutionsar.com\t",
            font: "Calibri",
            size: 18,
            color: "666666",
          }),
          new TextRun({
            children: [PageNumber.CURRENT],
            font: "Calibri",
            size: 18,
            color: "666666",
          }),
        ],
      }),
    ],
  });

  const coverBlock: Paragraph[] = [
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: "WORKING AGREEMENT",
          bold: true,
          font: "Calibri",
          size: 32,
          color: BRAND_BLUE,
        }),
      ],
    }),
    para("PREPARED FOR:", { spacingAfter: 40 }),
    para("{{client_name}}", { spacingAfter: 40 }),
    para("{{property_address}}", { spacingAfter: 160 }),
    para("DATE:", { spacingAfter: 40 }),
    para("{{today_date}}", { spacingAfter: 200 }),
  ];

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        headers: { default: new Header({ children: headerChildren }) },
        footers: { default: footer },
        children: [
          ...coverBlock,
          para(
            "In the details of this Working Agreement, you will find essential information about working with Columbus Home Solutions, LLC — including how you'll be updated on your project, how our pricing works, our terms and conditions, and your payment schedule.",
          ),
          para(
            "Please review all the details to ensure your expectations and our communication are perfectly clear throughout your project.",
          ),
          para("Thank you for your business,"),
          para("Tony Columbus"),
          para("Columbus Home Solutions, LLC", { spacingAfter: 280 }),

          sectionTitle("Section 1 — Communication: How You Will Be Updated"),
          bullet(
            "It is our goal to keep you continuously informed throughout the duration of your project. We will provide updates every week by phone, text, or email.",
          ),
          bullet(
            "{{pm_name}} will be your primary point of contact. If you have any questions, decisions to make, or issues to resolve, {{pm_name}} can be reached directly:",
          ),
          bullet("Phone / Text: {{pm_phone}}", ["{{pm_phone}}"]),
          bullet("Email: {{pm_email}}", ["{{pm_email}}"]),
          bullet(
            "You will also have access to your secure Client Portal at any time, where you can view project photos, your schedule, invoices, and documents, and send messages directly to our team.",
          ),
          bullet(
            "If you need to meet in person to discuss anything, we are happy to do so — just reach out and we will find a time that works for both of us.",
          ),
          bullet(
            "If you ever have questions or concerns, please reach out without hesitation. It is our goal to answer all questions and resolve any issues promptly and professionally.",
          ),

          sectionTitle("Section 2 — Terms & Conditions"),
          new Paragraph({
            spacing: { before: 120, after: 120 },
            children: [bold("How Our Pricing Works", BRAND_GOLD)],
          }),
          bullet(
            "Columbus Home Solutions provides detailed project estimates before any work begins. Our pricing is based on current material costs and the agreed scope of work.",
          ),
          bullet(
            "We strive to be on-budget contractors. Rather than guessing, we build detailed estimates and manage our projects to deliver on budget. However, project costs may change if circumstances outside our control arise.",
          ),
          bullet("Examples of factors that could affect pricing:"),
          bullet("Manufacturer material price changes after contract execution"),
          bullet("Change orders requested by the client"),
          bullet("Weather-related delays affecting scheduling or material delivery"),
          bullet("Additional construction needs discovered after demolition or wall removal"),
          bullet(
            "If any changes occur, you will be notified immediately and must approve any changes before additional costs are incurred. We will never charge for work or change pricing without your prior approval.",
          ),
          new Paragraph({
            spacing: { before: 120, after: 120 },
            children: [bold("Expectations", BRAND_GOLD)],
          }),
          bullet(
            "All deposits and material purchases are final and non-refundable. All installed products are non-refundable. All special-order products are non-refundable.",
          ),
          bullet(
            "Our team is skilled, detail-oriented, and thorough. However, additional construction needs may be revealed after demolition. These will always be communicated immediately, with solutions to choose from, and no additional charges will be made without approval.",
          ),
          bullet(
            "We will not perform any work that violates city codes, HOA policies, or general construction best practices.",
          ),
          bullet(
            "Some work will be performed by subcontractors who are specialists in their trades. These subcontractors have been carefully selected based on skill, craftsmanship, and reliability. Columbus Home Solutions manages all subcontractor relationships and is responsible for the quality of their work.",
          ),

          sectionTitle("Section 3 — Price Escalation Clause"),
          para(
            "The contract price has been calculated based on current building material prices. The market for building materials can be volatile, and sudden price increases may occur. Columbus Home Solutions will use its best efforts to obtain the lowest possible prices from available suppliers. Should there be an increase in specified material prices after contract execution, the client agrees to pay that verified cost increase.",
          ),
          para(
            "Any claim for a price increase will be supported by written notice stating the increased cost, the materials in question, and the supplier source, with invoices or bills of sale attached. Should a material price increase cause the total contract price to rise by more than 10%, Columbus Home Solutions will notify the client in writing before making additional purchases, and the client may choose to approve the increase, select alternative materials, or modify the scope of work.",
          ),

          sectionTitle("Section 4 — Change Order Policy"),
          para(
            "Any changes to the agreed scope of work must be submitted as a written Change Order. Once a signed Change Order is received from the client and approved by Columbus Home Solutions, we will proceed with the change. No scope changes will be made without these steps.",
          ),
          para(
            "The client understands that change orders may affect the project timeline and payment schedule. All change order costs must be paid as documented in the approved Change Order.",
          ),

          sectionTitle("Section 5 — Payment Schedule"),
          para(
            "Payment draws are tied to project milestones as documented in your contract and estimate. If a payment draw is not received by the agreed timeframe, work will pause until the outstanding balance is received, at which point work will resume promptly.",
          ),
          para(
            "All invoices are due within seven (7) days of receipt. A late fee of $50.00 per day applies to invoices not paid within seven (7) days.",
          ),
        ],
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, buf);
  console.log(`✓ Wrote ${OUT_PATH} (${buf.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
