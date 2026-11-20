/** A how-to page in Knowledge. The body is simple text: "## " starts a heading, "- " a list item, a blank line a paragraph. */
export interface Guide { slug: string; title: string; area: string; body: string }

export const GUIDES: Guide[] = [
  {
    slug: "getting-started", title: "Getting started", area: "Setup",
    body: `## First steps
- Settings → Garage details: name, TRN, address, emirate, bank details and logo (they print on every document).
- Settings → Users: add your accountant and service advisors. Owners see everything; advisors never see costs, books or salaries.
- Settings → Tax: whether your prices include VAT, and your VAT return period.
- Settings → Books: the day your books start. Then Books → Opening balances.

## Working on several PCs
Use one PC as the main computer, or link the garage to Fleetfix Cloud: every PC and the browser app then share the same data, and work carries on offline.`,
  },
  {
    slug: "workshop", title: "The workshop: estimate to invoice", area: "Operations",
    body: `## The flow
- New estimate: pick the customer and vehicle, add labour, parts and other lines. Send it for approval.
- Approved: convert it to a job card. Parts fitted on the job card come out of stock straight away.
- Job done: convert the job card to an invoice and issue it. An issued invoice can't change: correct it with a credit note.

## Tips
- Parts supplied by Fleet Fix print at no charge and touch no stock.
- A discount on a line comes off before VAT. For a promo code, see "Promo codes".`,
  },
  {
    slug: "getting-paid", title: "Getting paid", area: "Finance",
    body: `## Receipts
- Record a receipt from the invoice or from Receipts. One receipt can pay several invoices; money not put against an invoice stays as the customer's credit.
- Cheques wait in "cheques in hand" until you pay them in from Bank & cash.

## Credit customers
- Set a credit limit and payment terms on the customer. Reports → Aging shows who owes what, by how late.
- Statements go out from the dashboard each month by email or WhatsApp.`,
  },
  {
    slug: "purchases-stock", title: "Purchases and stock", area: "Inventory",
    body: `## Buying parts
- Purchases: raise a purchase order to a supplier, send it, then receive the goods with the supplier's invoice number. Stock goes up at the price paid.
- Parts bought for one job can be received straight onto its job card.

## Stock
- Parts shows what's on hand at average cost. Count stock and post the differences from the part's page.
- Bills (Finance) are for everything that isn't parts on a purchase order: rent, utilities, outside work.`,
  },
  {
    slug: "books", title: "The books", area: "Accounts",
    body: `## How the books fill up
Invoices, credit notes, receipts, parts received, stock, bills, expenses, payroll and depreciation post to the books by themselves. Your accountant adds journals for anything else.

## Checking them
- Books → Books health compares the books with the workshop: receivables, payables, stock, VAT, fixed assets. Every line should say OK.
- Trial balance, Profit and loss, Balance sheet and the ledger export to Excel or PDF.
- Lock the books up to a date when a month is finished; close the year from Settings → Books.`,
  },
  {
    slug: "vat-return", title: "The VAT return", area: "Accounts",
    body: `## Each period
- Books → VAT return shows the VAT201 boxes for the period, worked out from the books. Click a box to see its entries.
- Zero-rated, exempt, reverse charge and corrections come from journals with the line's VAT box chosen.
- File the return on the FTA portal, then Mark as filed here: it posts the settlement into VAT payable and locks the period.
- Record the payment from the filed return.`,
  },
  {
    slug: "payroll", title: "Payroll and leavers", area: "HR & Payroll",
    body: `## Before the first payroll
Settings → Payroll: your MOHRE establishment ID, the employer's bank routing code, and how pay is worked out (gratuity day rate and cap, leave basis, salary day rate).

## Each month
- Payroll → Run payroll for the month. The app proposes each person's pay: part months, unpaid leave and advance instalments.
- Type cash bonuses and extras, then the owner approves. Approval posts the salaries and the gratuity put aside.
- Download the WPS file for your bank, mark WPS paid, print the bonus voucher and payslips, or send payslips by email or WhatsApp.

## Leavers
Enter the last day on the employee, then Final settlement: salary to the last day, leave not taken, end-of-service gratuity (after a year of service), less advances. Change an amount with a reason, approve, pay and print the letter.`,
  },
  {
    slug: "fixed-assets", title: "Fixed assets", area: "Accounts",
    body: `## The register
- Record the purchase as usual (a supplier bill to 1500 Tools and equipment, 1510 Vehicles or 1520 Fit-out), then add the asset in Accounts → Fixed assets with its cost, date in use and useful life.
- Depreciation posts by itself when each month ends: straight line, a full month from the month it goes into use.
- Selling or writing it off: depreciation runs through that month, then the gain or loss posts.`,
  },
  {
    slug: "messages", title: "Messages and templates", area: "Settings",
    body: `## Messages
- Settings → Messages: your mail server and, for each message (vehicle received, estimate ready, invoice, payment, statement, payslip), whether it goes by email, WhatsApp or both, automatically or after asking.
- Texts use placeholders such as {customer}, {plate}, {doc_number} and {amount}.

## Templates
Settings → Message templates: write your own texts (in English and Arabic) and pick one in the Send dialog. The text can still be edited before sending.`,
  },
  {
    slug: "promo-codes", title: "Promo codes", area: "Operations",
    body: `## Making a code
Settings → Promo codes: the code, % or AED off, labour, parts or both, the dates it's valid, a minimum bill, how many times it can be used and whether once per customer.

## Using it
- On a draft estimate, job card or invoice, type the code and Apply. The discount comes off before VAT and prints on the document.
- A use counts when the invoice is issued. Reports → Promo codes shows each code's uses and the discount given.`,
  },
  {
    slug: "integrations", title: "Integrations", area: "Settings",
    body: `## What can connect
- WhatsApp Business API: messages go by themselves, using templates Meta has approved.
- Zoho Books and QuickBooks: customers, invoices, credit notes and payments are sent one way from Fleetfix.

## What you need
Integrations run in Fleetfix Cloud. Each needs your own developer app with the provider (Meta, Zoho or Intuit). Settings → Integrations shows each card's status and errors.`,
  },
  {
    slug: "backups-cloud", title: "Backups and the cloud", area: "Settings",
    body: `## Backups
Settings → Backups: the app backs up by itself every day. Keep a copy off the PC too (a USB drive or a cloud folder).

## Fleetfix Cloud
Link the garage to the cloud to use it from a browser, share data between PCs and send messages. Each PC keeps working offline and catches up when it's back online.`,
  },
];

/** Guides whose title or text holds every word of `q` (all of them for an empty search). */
export function searchGuides(q: string): Guide[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return GUIDES;
  return GUIDES.filter((g) => {
    const text = `${g.title} ${g.area} ${g.body}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
