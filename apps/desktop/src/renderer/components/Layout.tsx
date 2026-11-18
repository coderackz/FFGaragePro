import clsx from "clsx";
import { Car, FileText, LayoutDashboard, LogOut, Package, Receipt, Settings, ShoppingCart, Truck, UserCog, Users, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { ROLE_LABELS } from "@ffgp/shared";
import logo from "../assets/fleetfix-logo.png";
import { useAuth } from "../lib/auth";

export function Layout({ children }: { children: ReactNode }) {
  const { user, garage, canSee: can, signOut, licence } = useAuth();
  const nav = [
    { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
    { section: "Workshop" },
    { to: "/estimates", label: "Estimates", icon: FileText },
    { to: "/jobcards", label: "Job Cards", icon: Wrench },
    { to: "/invoices", label: "Invoices", icon: Receipt },
    { section: "Records" },
    { to: "/customers", label: "Customers", icon: Users },
    { to: "/vehicles", label: "Vehicles", icon: Car },
    { section: "Inventory" },
    { to: "/parts", label: "Parts", icon: Package },
    { to: "/purchase-orders", label: "Purchases", icon: ShoppingCart },
    { to: "/suppliers", label: "Suppliers", icon: Truck },
    ...(can("users.manage") || can("settings.manage") ? [{ section: "Admin" }] : []),
    ...(can("users.manage") ? [{ to: "/users", label: "Users", icon: UserCog }] : []),
    ...(can("settings.manage") ? [{ to: "/settings", label: "Settings", icon: Settings }] : []),
  ] as const;

  return (
    <div className="flex h-full">
      {/* Tablets (< 1024 px): icons only, so the work area keeps its width. */}
      <aside className="flex w-60 shrink-0 flex-col bg-ink text-zinc-300 max-lg:w-16">
        <div className="px-5 pt-5 pb-4 max-lg:px-2">
          <img src={logo} alt="Fleet Fix" className="h-9 w-auto max-lg:h-auto max-lg:w-full" />
          <div className="mt-2 text-[11px] font-semibold tracking-[0.18em] text-brand uppercase max-lg:hidden">Garage Pro</div>
        </div>
        <div className="mx-3 mb-3 truncate rounded-md bg-white/5 px-3 py-2 text-[13px] text-zinc-200 max-lg:hidden" title={garage?.name}>
          {garage?.name}
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-3 max-lg:px-2">
          {nav.map((item, i) =>
            "section" in item ? (
              <div key={`s${i}`} className="px-3 pt-4 pb-1.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase max-lg:px-0 max-lg:text-center max-lg:text-[0px] max-lg:after:block max-lg:after:mx-auto max-lg:after:h-px max-lg:after:w-6 max-lg:after:bg-white/10">{item.section}</div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                end={"end" in item ? item.end : false}
                className={({ isActive }) =>
                  clsx(
                    "relative mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors max-lg:justify-center max-lg:px-0",
                    isActive ? "bg-white/10 font-medium text-white" : "hover:bg-white/5 hover:text-white",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r bg-brand" />}
                    <item.icon className={clsx("size-4 shrink-0", isActive ? "text-brand" : "text-zinc-500")} />
                    <span className="max-lg:hidden">{item.label}</span>
                  </>
                )}
              </NavLink>
            ),
          )}
        </nav>
        <div className="flex items-center gap-2.5 border-t border-white/10 px-4 py-3 max-lg:flex-col max-lg:px-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-ink">{user?.name.slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1 max-lg:hidden">
            <div className="truncate text-sm text-white">{user?.name}</div>
            <div className="truncate text-xs text-zinc-500">{user && ROLE_LABELS[user.role]}</div>
          </div>
          <button type="button" onClick={() => void signOut()} className="rounded p-1.5 text-zinc-500 hover:bg-white/10 hover:text-white" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <LicenceBanner licence={licence} />
        <div className="mx-auto max-w-[1280px] px-8 py-6 max-lg:px-5">{children}</div>
      </main>
    </div>
  );
}

/** Fleetfix Cloud: trial ending, grace period, or read-only. Nothing for active subscriptions or the PC app. */
function LicenceBanner({ licence }: { licence: ReturnType<typeof useAuth>["licence"] }) {
  if (!licence) return null;
  const days = `${licence.daysLeft} day${licence.daysLeft === 1 ? "" : "s"}`;
  if (licence.state === "trial" && licence.daysLeft <= 14) {
    return <div className="bg-sky-50 px-8 py-2 text-sm text-sky-900" data-testid="licence-banner">Free trial ends in {days}. Contact Fleet Fix to keep using Garage Pro.</div>;
  }
  if (licence.state === "grace") {
    return <div className="bg-amber-50 px-8 py-2 text-sm text-amber-900" data-testid="licence-banner"><b>Subscription ended</b> — {days} left to renew before the garage becomes read-only. Contact Fleet Fix.</div>;
  }
  if (licence.state === "read_only") {
    return <div className="bg-red-50 px-8 py-2 text-sm text-red-800" data-testid="licence-banner"><b>Read-only:</b> the subscription has ended. You can still view and print. Contact Fleet Fix to renew.</div>;
  }
  return null;
}
