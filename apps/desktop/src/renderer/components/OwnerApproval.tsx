import { useRef, useState, type FormEvent } from "react";
import type { ApprovalInput } from "@ffgp/shared";
import { ApiError } from "../lib/api";
import { Button, Field, Input, Modal } from "./ui";

/**
 * "Owner approval": when a save is refused because a discount is over the user's limit, asks for the Owner's
 * username and password on the spot and retries with them. `withApproval(send)` runs `send()` and, on a
 * discount_approval refusal, asks and calls `send(approval)` until it works or the person cancels.
 */
export function useOwnerApproval() {
  const [ask, setAsk] = useState<{ message: string; resolve: (a: ApprovalInput | null) => void } | null>(null);
  const [form, setForm] = useState({ username: "", password: "" });
  const resolved = useRef(false);

  const request = (message: string) =>
    new Promise<ApprovalInput | null>((resolve) => {
      resolved.current = false;
      setForm((f) => ({ username: f.username, password: "" }));
      setAsk({ message, resolve });
    });
  const finish = (a: ApprovalInput | null) => {
    if (resolved.current) return;
    resolved.current = true;
    ask?.resolve(a);
    setAsk(null);
  };

  async function withApproval<T>(send: (approval?: ApprovalInput) => Promise<T>): Promise<T> {
    let approval: ApprovalInput | undefined;
    let message: string | null = null;
    for (;;) {
      try {
        return await send(approval);
      } catch (err) {
        // Any "…_approval" refusal: a discount over the limit, going over a credit limit.
        if (!(err instanceof ApiError) || !err.code?.endsWith("_approval")) throw err;
        message = approval ? "That username or password isn't right. Ask the Owner to try again." : err.message;
        const given = await request(message);
        if (!given) throw new Error("Not done: it needs the Owner's approval.");
        approval = given;
      }
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    finish({ username: form.username.trim(), password: form.password });
  };

  const dialog = (
    <Modal
      open={!!ask}
      title="Owner approval"
      onClose={() => finish(null)}
      footer={<><Button onClick={() => finish(null)}>Cancel</Button><Button variant="primary" type="submit" form="owner-approval">Approve</Button></>}
    >
      <form id="owner-approval" onSubmit={submit} className="space-y-3">
        <p className="text-sm text-zinc-700">{ask?.message.replace(/\.?$/, ".")} The Owner types their username and password to approve it.</p>
        <Field label="Owner's username"><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" autoFocus required /></Field>
        <Field label="Owner's password"><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="off" required /></Field>
      </form>
    </Modal>
  );
  return { withApproval, dialog };
}
