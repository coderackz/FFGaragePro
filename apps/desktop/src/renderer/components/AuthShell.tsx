import type { ReactNode } from "react";
import logo from "../assets/fleetfix-logo.png";

export function AuthShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex h-full">
      <div className="relative hidden w-[42%] max-w-xl flex-col justify-between overflow-hidden bg-ink p-10 text-white lg:flex">
        <div className="absolute -right-24 -bottom-24 size-96 rounded-full bg-brand/10" />
        <div className="absolute -right-10 -bottom-10 size-56 rounded-full bg-brand/10" />
        <div>
          <img src={logo} alt="Fleet Fix" className="h-14 w-auto" />
          <div className="mt-3 text-xs font-semibold tracking-[0.22em] text-brand uppercase">Garage Pro</div>
        </div>
        <div className="relative max-w-sm">
          <div className="text-2xl leading-snug font-semibold">Run your whole garage from one place.</div>
          <div className="mt-3 text-sm text-zinc-400">Estimates, job cards, invoices with VAT, customers and vehicles. Works with or without internet.</div>
        </div>
        <div className="relative text-xs text-zinc-500">© Fleetfix · fleet care simplified</div>
      </div>
      {/* m-auto centres the form while it fits, and lets it scroll from the top when the window is short. */}
      <div className="flex flex-1 overflow-y-auto bg-white p-8">
        <div className={wide ? "m-auto w-full max-w-2xl" : "m-auto w-full max-w-sm"}>{children}</div>
      </div>
    </div>
  );
}
