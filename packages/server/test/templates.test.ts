import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp } from "./helpers";

const REMINDER = {
  name: "Service reminder", channel: "both", subjectEn: "Service due for {plate}",
  textEn: "Dear {customer}, {plate} is due for its service. {garage}",
};

describe("message templates", () => {
  it("templates", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const made = await call(app, "POST", "/api/message-templates", owner, REMINDER);
    expect(made.status).toBe(200);
    expect(made.body.template).toMatchObject({ name: "Service reminder", channel: "both" });
    const bad = await call(app, "POST", "/api/message-templates", owner, { ...REMINDER, textEn: "Hi {name}" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/\{name\}/);
    expect((await call(app, "POST", "/api/message-templates", owner, { ...REMINDER, channel: "email", subjectEn: "" })).status).toBe(400);
    expect((await call(app, "POST", "/api/message-templates", owner, { ...REMINDER, channel: "whatsapp", subjectEn: "" })).status).toBe(200);
    const list = async (channel: string) => (await call(app, "GET", `/api/message-templates?channel=${channel}`, owner)).body.templates.map((t: { name: string }) => t.name);
    expect(await list("whatsapp")).toEqual(["Service reminder", "Service reminder"]);
    expect(await list("email")).toEqual(["Service reminder"]);
    expect((await call(app, "PATCH", `/api/message-templates/${made.body.template.id}`, owner, { name: "Service due" })).body.template.name).toBe("Service due");
    await call(app, "POST", `/api/message-templates/${made.body.template.id}/archive`, owner, {});
    expect(await list("email")).toEqual([]);
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "POST", "/api/message-templates", advisor, REMINDER)).status).toBe(403);
    expect((await call(app, "GET", "/api/message-templates?channel=whatsapp", advisor)).status).toBe(200);
  });
});
