import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIONS,
  BOOKING_CODE_PATTERN,
  DATE_PATTERN,
  REQUIRED_KEYS,
  SPECIALTIES,
  TIME_WINDOWS,
  outputSchema,
  validate,
} from "../src/schema.js";

const validOutput = () => ({
  action: "book",
  specialty: "cardiologia",
  date: "2026-11-05",
  time_window: "afternoon",
  booking_code: "RS-4821",
  reply: "Listo, te reservo el jueves a la tarde.",
});

test("schema: declares all six required keys and forbids additional ones", () => {
  assert.deepEqual([...outputSchema.required].sort(), [...REQUIRED_KEYS].sort());
  assert.equal(outputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(outputSchema.properties).sort(), [...REQUIRED_KEYS].sort());
});

test("schema: enums match the documented actions and specialties", () => {
  assert.deepEqual(ACTIONS, [
    "book",
    "availability",
    "cancel",
    "reschedule",
    "clarify",
    "escalate",
    "decline",
  ]);
  assert.deepEqual(SPECIALTIES, [
    "clinica",
    "pediatria",
    "cardiologia",
    "dermatologia",
    "ginecologia",
    "traumatologia",
    "oftalmologia",
  ]);
  assert.deepEqual(TIME_WINDOWS, ["morning", "afternoon", "any"]);
  assert.equal(DATE_PATTERN, "^\\d{4}-\\d{2}-\\d{2}$");
  assert.equal(BOOKING_CODE_PATTERN, "^RS-\\d{4}$");
});

test("schema: a complete valid object passes", () => {
  const result = validate(validOutput());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("schema: nulls are valid for the nullable fields", () => {
  const result = validate({
    action: "clarify",
    specialty: null,
    date: null,
    time_window: null,
    booking_code: null,
    reply: "¿Para qué especialidad?",
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("schema: a missing key fails", () => {
  const output = validOutput();
  delete output.reply;
  const result = validate(output);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.startsWith("reply:")), result.errors.join("; "));
});

test("schema: an extra key fails", () => {
  const result = validate({ ...validOutput(), confidence: 0.9 });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) => error.includes("confidence")),
    result.errors.join("; "),
  );
});

test("schema: a bad action enum fails", () => {
  const result = validate({ ...validOutput(), action: "transferir" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.startsWith("action:")), result.errors.join("; "));
});

test("schema: a bad specialty enum fails", () => {
  const result = validate({ ...validOutput(), specialty: "kinesiologia" });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) => error.startsWith("specialty:")),
    result.errors.join("; "),
  );
});

test("schema: a bad time_window enum fails", () => {
  const result = validate({ ...validOutput(), time_window: "night" });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) => error.startsWith("time_window:")),
    result.errors.join("; "),
  );
});

// NOTE: the schema constrains `date` by pattern only, so calendar-impossible values
// such as "2026-13-01" are schema-valid on purpose (the local validator must not
// be stricter than the schema sent to providers).
test("schema: a bad date fails", () => {
  for (const date of ["05/11/2026", "2026-11-5", "2026-13-01x", "mañana", "2026/11/05"]) {
    const result = validate({ ...validOutput(), date });
    assert.equal(result.valid, false, `date ${date} should fail`);
    assert.ok(result.errors.some((error) => error.startsWith("date:")), result.errors.join("; "));
  }
});

test("schema: a bad booking code fails", () => {
  for (const bookingCode of ["4821", "RS-482", "RS-48211", "XY-4821"]) {
    const result = validate({ ...validOutput(), booking_code: bookingCode });
    assert.equal(result.valid, false, `booking_code ${bookingCode} should fail`);
    assert.ok(
      result.errors.some((error) => error.startsWith("booking_code:")),
      result.errors.join("; "),
    );
  }
});

test("schema: non-string reply fails", () => {
  const result = validate({ ...validOutput(), reply: 42 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.startsWith("reply:")), result.errors.join("; "));
});

test("schema: non-object inputs fail", () => {
  for (const value of [null, undefined, "{}", 42, []]) {
    const result = validate(value);
    assert.equal(result.valid, false, `${JSON.stringify(value)} should fail`);
    assert.ok(result.errors.length > 0);
  }
});
