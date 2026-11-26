# Remove Arabic — design

**Date:** 2026-11-27 · **Status:** the user chose "All Arabic in the app", then "remove everything" (the saved Arabic too). The deletion is confirmed once more with the user before it reaches the cloud.

## What goes
- **Printouts:** the Arabic line under every title; English + Arabic documents (estimates, job cards, invoices, credit notes, receipts, statements, payslips, settlements); the amount in Arabic words; the embedded Arabic font; "قطعة مستعملة"; Arabic on vendor PDFs. Everything prints English only, reprints of issued invoices included.
- **Customers and contacts:** Arabic name and address, document language, message language.
- **Messages:** Arabic subject and text on every event and template; sending in Arabic. Everyone gets English.
- **Garage, documents settings, parts, employees:** the garage's Arabic name and address, Arabic terms and warranty text, a part's Arabic name, an employee's Arabic name and payslip language.
- **Saved data (migration 30):** columns dropped — customers.name_ar, address_ar, doc_language, message_language; parts.name_ar; documents.language; customer_contacts.language; employees.name_ar, language; message_templates.subject_ar, text_ar. Settings rows garage.nameAr/addressAr and documents.termsAr/warrantyAr deleted; Arabic subject/text removed from each message event's setting. Sync triggers on those tables are dropped first (they name the columns) and reinstalled at start, as always.

## What stays *(my call)*
- **The message log:** messages already sent in Arabic stay as sent (a record of what the customer received).
- **WhatsApp Business template language codes** (Meta's "ar"/"en" per approved template) stay: they name Meta's template, not app text *(checked during the build; removed if only used for Arabic)*.

## Constraints
- The cloud is updated before PCs; an older PC stops syncing until updated (schema version), as always.
- Cloud daily backups keep the old Arabic for 30 days.
