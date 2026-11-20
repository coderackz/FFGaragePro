import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Button, Spinner } from "./components/ui";
import { Layout } from "./components/Layout";
import { useAuth } from "./lib/auth";
import { ConnectPage } from "./pages/ConnectPage";
import { CustomerPage } from "./pages/CustomerPage";
import { CustomersPage } from "./pages/CustomersPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DocumentPage } from "./pages/DocumentPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { GaragePage } from "./pages/GaragePage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsHome } from "./pages/settings/SettingsHome";
import { SettingsSectionPage } from "./pages/settings/SettingsSectionPage";
import { SetupPage } from "./pages/SetupPage";
import { VehiclesPage } from "./pages/VehiclesPage";
import { PartPage } from "./pages/PartPage";
import { PartsPage } from "./pages/PartsPage";
import { PurchaseOrderPage } from "./pages/PurchaseOrderPage";
import { PurchaseOrdersPage } from "./pages/PurchaseOrdersPage";
import { SuppliersPage } from "./pages/SuppliersPage";
import { AccountsPage } from "./pages/books/AccountsPage";
import { BooksHome } from "./pages/books/BooksHome";
import { HealthPage } from "./pages/books/HealthPage";
import { VatReturnPage } from "./pages/books/VatReturnPage";
import { JournalEditor } from "./pages/books/JournalEditor";
import { JournalsPage, JournalView } from "./pages/books/JournalsPage";
import { ReportPage } from "./pages/books/ReportPage";
import { AgingPage } from "./pages/AgingPage";
import { BillsPage } from "./pages/payables/BillsPage";
import { EmployeePage } from "./pages/payroll/EmployeePage";
import { EmployeesPage } from "./pages/payroll/EmployeesPage";
import { PayrollPage } from "./pages/payroll/PayrollPage";
import { PayrollRunPage } from "./pages/payroll/PayrollRunPage";
import { ExpensesPage } from "./pages/payables/ExpensesPage";
import { MoneyPage } from "./pages/payables/MoneyPage";
import { PayablesAgingPage } from "./pages/payables/PayablesAgingPage";
import { ReconcilePage } from "./pages/payables/ReconcilePage";
import { SupplierPage } from "./pages/payables/SupplierPage";
import { ReceiptsPage } from "./pages/ReceiptsPage";

export function App() {
  const { state, canSee, retry, startConnect } = useAuth();
  const main = window.ffgp?.mainComputer;

  if (state.phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (state.phase === "offline") {
    return (
      <Notice
        title={main ? "Can't reach the main computer" : "Can't reach the garage server"}
        actions={
          <>
            <Button variant="primary" onClick={retry}>Try again</Button>
            {main && <Button onClick={startConnect}>Connect to a different main computer</Button>}
          </>
        }
      >
        {main
          ? <>This PC works through <b>{main.garageName || "the garage"}</b>'s main computer at <b>{main.host}</b>. Check that it is switched on, the app is open on it, and both PCs are on the same network.</>
          : <>{state.message}.</>}
      </Notice>
    );
  }
  if (state.phase === "unpaired") {
    return (
      <Notice title="This PC is no longer connected" actions={<Button variant="primary" onClick={startConnect}>Connect again</Button>}>
        The owner removed this PC from {main?.garageName || "the garage"}'s main computer, or the main computer was set up again. Ask the owner for a new pairing code.
      </Notice>
    );
  }
  if (state.phase === "garage") return <GaragePage error={state.error} />;
  if (state.phase === "connect") return <ConnectPage />;
  if (state.phase === "setup") return <SetupPage />;
  if (state.phase === "signed-out") return <LoginPage />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/estimates" element={<DocumentsPage type="estimate" />} />
        <Route path="/jobcards" element={<DocumentsPage type="jobcard" />} />
        <Route path="/invoices" element={<DocumentsPage type="invoice" />} />
        <Route path="/credit-notes" element={<DocumentsPage type="credit_note" />} />
        <Route path="/receipts" element={<ReceiptsPage />} />
        {canSee("reports.view") && <Route path="/reports/aging" element={<AgingPage />} />}
        {canSee("payroll.manage") && (
          <>
            <Route path="/employees" element={<EmployeesPage />} />
            <Route path="/employees/:id" element={<EmployeePage />} />
            <Route path="/payroll" element={<PayrollPage />} />
            <Route path="/payroll/:id" element={<PayrollRunPage />} />
          </>
        )}
        {canSee("payables.manage") && (
          <>
            <Route path="/bills" element={<BillsPage />} />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/bank" element={<MoneyPage />} />
            <Route path="/bank/:id/reconcile" element={<ReconcilePage />} />
            <Route path="/suppliers/:id" element={<SupplierPage />} />
            <Route path="/reports/payables-aging" element={<PayablesAgingPage />} />
          </>
        )}
        {canSee("books.view") && (
          <>
            <Route path="/books" element={<BooksHome />} />
            <Route path="/books/trial-balance" element={<ReportPage key="tb" kind="trial-balance" />} />
            <Route path="/books/profit-loss" element={<ReportPage key="pl" kind="profit-loss" />} />
            <Route path="/books/balance-sheet" element={<ReportPage key="bs" kind="balance-sheet" />} />
            <Route path="/books/ledger" element={<ReportPage key="gl" kind="ledger" />} />
            <Route path="/books/journals" element={<JournalsPage />} />
            <Route path="/books/journals/new" element={<JournalEditor key="new" />} />
            <Route path="/books/journals/:id" element={<JournalView />} />
            <Route path="/books/drafts/:id" element={<JournalEditor key="draft" />} />
            <Route path="/books/opening" element={<JournalEditor key="opening" opening />} />
            <Route path="/books/accounts" element={<AccountsPage />} />
            <Route path="/books/health" element={<HealthPage />} />
            <Route path="/books/vat" element={<VatReturnPage />} />
          </>
        )}
        <Route path="/documents/new/:type" element={<DocumentPage />} />
        <Route path="/documents/:id" element={<DocumentPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/customers/:id" element={<CustomerPage />} />
        <Route path="/vehicles" element={<VehiclesPage />} />
        <Route path="/parts" element={<PartsPage />} />
        <Route path="/parts/:id" element={<PartPage />} />
        <Route path="/suppliers" element={<SuppliersPage />} />
        <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
        <Route path="/purchase-orders/new" element={<PurchaseOrderPage />} />
        <Route path="/purchase-orders/:id" element={<PurchaseOrderPage />} />
        {canSee("settings.manage") && <Route path="/users" element={<Navigate to="/settings/users" replace />} />}
        {canSee("settings.manage") && <Route path="/settings" element={<SettingsHome />} />}
        {canSee("settings.manage") && <Route path="/settings/:section" element={<SettingsSectionPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

function Notice({ title, children, actions }: { title: string; children: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-lg font-semibold">{title}</div>
      <div className="max-w-md text-sm text-zinc-500">{children}</div>
      <div className="mt-2 flex gap-2">{actions}</div>
    </div>
  );
}
