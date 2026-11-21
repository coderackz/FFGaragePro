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
- Bills (Finance) are for everything that isn't parts on a purchase order: rent, utilities, outside work.

## The parts catalogue
- Give a part a category (set them up in Settings → Inventory) and fill in that category's details, such as filter type or size.
- Other numbers: add the OEM and other brands' numbers. Searching any of them finds the part.
- Fits: list the vehicles a part fits (make, model, years, engine). On a job card the part picker shows "Fits" for the job's vehicle and lists fitting parts before you type. "Fits this vehicle" on a part line adds the job's vehicle to that part.
- Packs: say how a part is bought, such as "Box of 10". On a purchase order choose the pack, the number of packs and the price per pack. Stock is still counted in the part's own unit.
- Replaced by: when a supplier replaces a number, mark the old part as replaced. The parts list shows a "Replaced" badge and the picker points to the new part.

## Tyres and batteries, one by one
- On the part, set "Track each unit" to Tyres (by DOT) or Batteries (by serial). For a battery, enter the warranty in months.
- Receiving: type each tyre's DOT (week and year made, like 2524) or each battery's serial, one per unit. You can paste a list.
- On a job card or invoice, the part line lists the tyres on the shelf, oldest DOT first. "Pick the oldest" picks as many as the quantity, or tick the ones you fit.
- The invoice prints each DOT, or the battery's serial and the date its warranty ends (counted from the day it was fitted).
- Parts → "Find a serial or DOT" shows where a battery or tyre was fitted: the job, the customer and the vehicle.
- Taking stock off (damaged, lost) asks which ones went. A credit note that puts a tyre back on the shelf puts that tyre back.

## Kits
- A kit is a service package, such as "Minor service": one part made of other stocked parts (1 oil filter, 4.5 L of oil). Tick "This is a kit" on a new part and add its parts.
- Sold at the kit's own price. Its parts come off the shelf, and its cost is what they cost. The part page shows how many kits the shelf can make.

## Reordering
- On a part: "Reorder when at or below" (the minimum), "Order up to" (the maximum), the preferred supplier and how many days they take to deliver.
- Inventory → Reorder → Suggested orders lists every part at or below its reorder level, counting what's already on order, with the quantity that tops it up. "Make draft purchase orders" makes one draft per supplier at their last price; check and send them as usual.
- Min / max levels suggests levels from the last 90 days: enough for the lead time plus two weeks, up to a further 30 days. Use one, use all, or type your own, then Save levels (Owner).

## Stock reports
- Reports → Stock reports (Owner and Accountant): ABC (A parts are 80 % of what's used), fast and slow movers, dead stock (nothing used in 6 or 12 months), stock value by category, and aging by when each part was last received.`,
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

## Where
Integrations run in Fleetfix Cloud: open your garage at garagepro.fleetfix.ae as the owner, then Settings → Integrations. Their keys stay in the cloud and never come to a PC.

## WhatsApp Business API
- In your Meta app (WhatsApp → API Setup) copy the phone number ID and the WhatsApp business account ID. Make a permanent token for a system user, and copy the app secret (Settings → Basic).
- Paste them and press Connect WhatsApp. Then put the webhook URL and verify token shown on the card into Meta (WhatsApp → Configuration) so delivered and read come back.
- On a message template (Settings → Message templates), fill the approved template name, its language and its body parameters in order (for example customer, plate).
- In the Send dialog, pick that template: the button says Send on WhatsApp and the cloud sends it, with the PDF attached. Messages without an approved template still open WhatsApp as before.

## Zoho Books and QuickBooks
- Make a developer app (Zoho: api-console.zoho.com, server-based; QuickBooks: developer.intuit.com, Accounting) with the redirect URI shown on the card.
- Paste its client ID and secret, choose from when to send (blank: from today) and press Connect. Sign in and allow access; you come back to the card.
- Choose the VAT 5% tax and the items for labour, parts and other lines, then Save.
- From then on, issued invoices, credit notes and payments are sent by themselves (Send now sends at once). Nothing there is changed afterwards; anything refused shows on the card with Retry all.`,
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
