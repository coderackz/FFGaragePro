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
import { LoginPage } from "./pages/LoginPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { UsersPage } from "./pages/UsersPage";
import { VehiclesPage } from "./pages/VehiclesPage";
import { PartPage } from "./pages/PartPage";
import { PartsPage } from "./pages/PartsPage";
import { PurchaseOrderPage } from "./pages/PurchaseOrderPage";
import { PurchaseOrdersPage } from "./pages/PurchaseOrdersPage";
import { SuppliersPage } from "./pages/SuppliersPage";

export function App() {
  const { state, can, retry, startConnect } = useAuth();
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
        {can("users.manage") && <Route path="/users" element={<UsersPage />} />}
        {can("settings.manage") && <Route path="/settings" element={<SettingsPage />} />}
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
