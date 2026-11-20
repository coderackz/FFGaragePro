import type { Action } from "@ffgp/shared";
import {
  Banknote, BookOpen, Car, ChartBar, FileMinus, FileText, Hammer, IdCard, Landmark, LayoutDashboard, LifeBuoy, Package, Plug, Receipt, Scale, Settings, ShoppingCart, TicketPercent, Truck, Users, Wallet, Wrench, type LucideIcon,
} from "lucide-react";

export interface NavItem { to: string; label: string; icon: LucideIcon; end?: boolean }
export interface NavGroup { section: string | null; items: NavItem[] }

/**
 * The side menu, under standard headings. Each screen keeps the permission it always had; a heading with nothing the
 * user may open is left out.
 */
export function navGroups(can: (a: Action) => boolean): NavGroup[] {
  const when = (ok: boolean, ...items: NavItem[]) => (ok ? items : []);
  const groups: NavGroup[] = [
    { section: null, items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, end: true }] },
    {
      section: "Operations",
      items: [
        { to: "/estimates", label: "Estimates", icon: FileText },
        { to: "/jobcards", label: "Job Cards", icon: Wrench },
        { to: "/invoices", label: "Invoices", icon: Receipt },
        { to: "/customers", label: "Customers", icon: Users },
        { to: "/vehicles", label: "Vehicles", icon: Car },
      ],
    },
    {
      section: "Finance",
      items: [
        { to: "/receipts", label: "Receipts", icon: Banknote },
        { to: "/credit-notes", label: "Credit Notes", icon: FileMinus },
        ...when(can("payables.manage"),
          { to: "/bills", label: "Bills", icon: FileText },
          { to: "/expenses", label: "Expenses", icon: Wallet },
          { to: "/bank", label: "Bank & cash", icon: Landmark }),
      ],
    },
    {
      section: "Accounts",
      items: when(can("books.view"),
        { to: "/books", label: "Books", icon: BookOpen },
        { to: "/books/vat", label: "VAT return", icon: Scale },
        { to: "/books/assets", label: "Fixed assets", icon: Hammer }),
    },
    {
      section: "HR & Payroll",
      items: when(can("payroll.manage"),
        { to: "/employees", label: "Employees", icon: IdCard },
        { to: "/payroll", label: "Payroll", icon: Banknote }),
    },
    {
      section: "Inventory",
      items: [
        { to: "/parts", label: "Parts", icon: Package },
        { to: "/purchase-orders", label: "Purchases", icon: ShoppingCart },
        { to: "/suppliers", label: "Suppliers", icon: Truck },
      ],
    },
    {
      section: "Reports",
      items: [
        ...when(can("reports.view"), { to: "/reports/aging", label: "Aging", icon: ChartBar }),
        ...when(can("payables.manage"), { to: "/reports/payables-aging", label: "Payables aging", icon: ChartBar }),
        ...when(can("reports.view"), { to: "/reports/promo-codes", label: "Promo codes", icon: TicketPercent }),
      ],
    },
    { section: "Knowledge", items: [{ to: "/knowledge", label: "Help & guides", icon: LifeBuoy }] },
    // Users & roles live inside Settings.
    {
      section: "Settings",
      items: when(can("settings.manage"),
        { to: "/settings", label: "Settings", icon: Settings },
        { to: "/settings/integrations", label: "Integrations", icon: Plug }),
    },
  ];
  return groups.filter((g) => g.items.length);
}
