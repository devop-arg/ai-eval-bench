import assert from "node:assert/strict";
import test from "node:test";

import {
  detectTimeWindow,
  normalizeText,
  rulesOutput,
} from "../src/providers/baselines.js";
import { loadContext } from "../src/prompt.js";

// Hand-written messages (not copied from data/cases.jsonl) covering only the
// small a-priori vocabulary (docs/METHODOLOGY.md), against data/context.json: the clinic
// is open on Monday 2026-11-02 and closed on 2026-11-23.
const context = loadContext();

const parse = (message) => rulesOutput({ message }, { context });

test("rules: normalization strips accents and lowercases", () => {
  assert.equal(normalizeText("Cardiología A LA MAÑANA"), "cardiologia a la manana");
});

test("rules: resolves weekday names to the next occurrence after today", () => {
  const output = parse("Necesito un turno con el cardiologo para el jueves por la tarde.");
  assert.equal(output.action, "book");
  assert.equal(output.specialty, "cardiologia");
  assert.equal(output.date, "2026-11-05");
  assert.equal(output.time_window, "afternoon");

  // "el lunes" on a Monday is the following Monday, never today.
  const monday = parse("Turno de clinica medica el lunes a la manana");
  assert.equal(monday.date, "2026-11-09");
  assert.equal(monday.time_window, "morning");
  assert.equal(monday.specialty, "clinica");
});

test("rules: resolves relative, numeric and day-of-month dates", () => {
  assert.equal(parse("Turno de dermatologia el 5/11").date, "2026-11-05");
  assert.equal(parse("Turno de pediatria el 19").date, "2026-11-19");
  assert.equal(parse("Turno de traumatologia pasado manana").date, "2026-11-04");
  assert.equal(parse("Turno de pediatria manana a la tarde").date, "2026-11-03");
  assert.equal(parse("Turno de oftalmologia hoy").date, "2026-11-02");
});

test("rules: does not resolve month names or clock times", () => {
  const noMonth = parse("Turno de clinica medica en diciembre");
  assert.equal(noMonth.action, "book");
  assert.equal(noMonth.date, null);

  assert.equal(detectTimeWindow(normalizeText("Turno de clinica medica a las 9")), null);
  assert.equal(parse("Turno de clinica medica a las 17").time_window, "any");
});

test("rules: reads morning and afternoon phrases", () => {
  assert.equal(parse("Turno de cardiologia el jueves a la manana").time_window, "morning");
  assert.equal(parse("Turno de cardiologia el jueves por la tarde").time_window, "afternoon");
  assert.equal(parse("Turno de cardiologia el jueves").time_window, "any");
  assert.equal(detectTimeWindow(normalizeText("Turno de cardiologia el jueves")), null);
});

test("rules: asks to clarify Sundays, closed dates and Saturday afternoons", () => {
  const sunday = parse("Turno de dermatologia el domingo");
  assert.equal(sunday.action, "clarify");
  assert.equal(sunday.date, null);

  const closed = parse("Turno de clinica medica el 23");
  assert.equal(closed.action, "clarify");

  const saturdayAfternoon = parse("Turno de pediatria el sabado a la tarde");
  assert.equal(saturdayAfternoon.action, "clarify");

  const saturdayMorning = parse("Turno de pediatria el sabado a la manana");
  assert.equal(saturdayMorning.action, "book");
  assert.equal(saturdayMorning.date, "2026-11-07");
});

test("rules: extracts RS-#### codes and requires them to manage a booking", () => {
  const cancel = parse("Hola, quiero anular el turno rs-5555 por favor");
  assert.equal(cancel.action, "cancel");
  assert.equal(cancel.booking_code, "RS-5555");

  const missing = parse("Quiero cancelar el turno");
  assert.equal(missing.action, "clarify");
  assert.equal(missing.booking_code, null);

  const reschedule = parse("Necesito mover el RS-1234 para el viernes");
  assert.equal(reschedule.action, "reschedule");
  assert.equal(reschedule.date, "2026-11-06");
  assert.equal(reschedule.booking_code, "RS-1234");
  assert.equal(reschedule.time_window, null);

  const noDate = parse("Quiero cambiar el turno RS-4321");
  assert.equal(noDate.action, "clarify");
});

test("rules: answers availability questions only with a specialty", () => {
  const output = parse("Hay turno de oftalmologia el jueves?");
  assert.equal(output.action, "availability");
  assert.equal(output.specialty, "oftalmologia");
  assert.equal(output.date, "2026-11-05");
  assert.equal(output.time_window, "any");

  assert.equal(parse("Que horarios tienen?").action, "clarify");
});

test("rules: books when a specialty and a booking cue are present", () => {
  const output = parse("Hola, quiero reservar una consulta de ginecologia");
  assert.equal(output.action, "book");
  assert.equal(output.specialty, "ginecologia");
  assert.equal(output.date, null);
  assert.equal(output.time_window, "any");
});

test("rules: escalates emergencies before anything else", () => {
  assert.equal(parse("Tengo dolor de pecho y falta de aire").action, "escalate");
  assert.equal(parse("Turno de cardiologia, me desmaye ayer").action, "escalate");
  assert.equal(parse("Tengo convulsiones").action, "escalate");
});

test("rules: declines medical advice", () => {
  assert.equal(parse("Que dosis me tomo?").action, "decline");
  assert.equal(parse("Puedo tomar algo para el dolor?").action, "decline");
  assert.equal(parse("Es grave lo que tengo?").action, "decline");
  assert.equal(parse("Necesito una receta de medicamento").action, "decline");
});

test("rules: asks for the missing data when nothing is actionable", () => {
  assert.equal(parse("Hola, quiero un turno").action, "clarify");
  assert.equal(parse("Turno con odontologia el lunes").action, "clarify");
  assert.equal(parse("Me duele la rodilla desde ayer").action, "clarify");
});

test("rules: every action gets a fixed non-empty Spanish reply", () => {
  const messages = {
    book: "Turno de pediatria",
    availability: "Hay turno de pediatria?",
    cancel: "Anular el turno RS-1111",
    reschedule: "Mover el turno RS-2222 para el jueves",
    clarify: "Hola",
    escalate: "No puedo respirar",
    decline: "Que dosis tomo?",
  };

  for (const [action, message] of Object.entries(messages)) {
    const output = parse(message);
    assert.equal(output.action, action, message);
    assert.equal(typeof output.reply, "string", message);
    assert.equal(output.reply.length > 0, true, message);
  }
});
