import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Card, Empty, PageHeader, Table } from "../../components/ui";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import { EmployeeForm } from "./EmployeeForm";
import { grossOf, type Employee, type Expiring } from "./types";

const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);

/** The staff: who they are, what they're paid, and documents about to expire. */
export function EmployeesPage() {
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const { data, loading } = useApi<{ employees: Employee[] }>(`/api/employees${all ? "?includeLeft=1" : ""}`);
  const expiring = useApi<{ documents: Expiring[] }>("/api/payroll/expiring");
  const [adding, setAdding] = useState(false);
  const soon = (id: string) => expiring.data?.documents.filter((d) => d.employeeId === id) ?? [];
  return (
    <>
      <PageHeader title="Employees" subtitle="Staff, pay and documents"
        actions={<>
          <Button variant="ghost" onClick={() => setAll((v) => !v)}>{all ? "Current staff only" : "Show leavers too"}</Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>New employee</Button>
        </>} />
      <Card padded={false}>
        <Table rows={data?.employees ?? []} rowKey={(e) => e.id} onRowClick={(e) => navigate(`/employees/${e.id}`)}
          empty={!loading && <Empty icon={<Users className="size-10" />} title="No employees yet" />}
          columns={[
            { header: "Name", cell: (e) => <span className="font-medium">{e.name}{e.leftDate && <span className="ml-2"><Badge>Left {day(e.leftDate)}</Badge></span>}</span> },
            { header: "Job", cell: (e) => e.job },
            { header: "Joined", cell: (e) => day(e.joinDate) },
            { header: "Paid by", cell: (e) => (e.payMethod === "bank" ? "Bank" : "Salary card") },
            { header: "Documents", cell: (e) => soon(e.id).map((d) => <span key={d.document} className="mr-1"><Badge tone="red">{d.document} {day(d.expires)}</Badge></span>) },
            { header: "Gross", cell: (e) => formatAED(grossOf(e)), align: "right" },
          ]} />
      </Card>
      <EmployeeForm open={adding} employee={null} onClose={() => setAdding(false)} onSaved={(e) => navigate(`/employees/${e.id}`)} />
    </>
  );
}
