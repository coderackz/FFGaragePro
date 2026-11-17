import { Navigate, Route, Routes } from "react-router";
import { Button, Spinner } from "./components/ui";
import { Layout } from "./components/Layout";
import { useAuth } from "./lib/auth";
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

export function App() {
  const { state, can, retry } = useAuth();

  if (state.phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (state.phase === "offline") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="text-lg font-semibold">Can't reach the garage server</div>
        <div className="max-w-md text-sm text-zinc-500">{state.message}. If this PC connects to a main computer, check that it is switched on and on the same network.</div>
        <Button variant="primary" onClick={retry}>Try again</Button>
      </div>
    );
  }
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
        {can("users.manage") && <Route path="/users" element={<UsersPage />} />}
        {can("settings.manage") && <Route path="/settings" element={<SettingsPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
