/**
 * Output schema for the intake step. Documented in docs/METHODOLOGY.md.
 *
 * The same object is used for the provider request (structured output) and for
 * local validation. The validator is hand-written on purpose: no ajv, no build
 * step, no extra dependency.
 */

export const ACTIONS = [
  "book",
  "availability",
  "cancel",
  "reschedule",
  "clarify",
  "escalate",
  "decline",
];

export const SPECIALTIES = [
  "clinica",
  "pediatria",
  "cardiologia",
  "dermatologia",
  "ginecologia",
  "traumatologia",
  "oftalmologia",
];

export const TIME_WINDOWS = ["morning", "afternoon", "any"];

export const REQUIRED_KEYS = [
  "action",
  "specialty",
  "date",
  "time_window",
  "booking_code",
  "reply",
];

export const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
export const BOOKING_CODE_PATTERN = "^RS-\\d{4}$";

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: [...REQUIRED_KEYS],
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description:
        "Acción que el sistema de turnos debe ejecutar. `clarify` cuando falta un dato obligatorio, la fecha es ambigua o inválida, o el pedido cae fuera de horario.",
    },
    specialty: {
      anyOf: [{ type: "string", enum: [...SPECIALTIES] }, { type: "null" }],
      description: "Id de especialidad de la lista, o null si no se indicó.",
    },
    date: {
      anyOf: [
        { type: "string", pattern: DATE_PATTERN },
        { type: "null" },
      ],
      description:
        "Fecha resuelta como YYYY-MM-DD respecto de la fecha actual del consultorio, o null.",
    },
    time_window: {
      anyOf: [{ type: "string", enum: [...TIME_WINDOWS] }, { type: "null" }],
      description: "Franja horaria preferida, o null si la acción no la usa.",
    },
    booking_code: {
      anyOf: [
        { type: "string", pattern: BOOKING_CODE_PATTERN },
        { type: "null" },
      ],
      description: "Código de reserva RS-#### si el paciente lo dio, o null.",
    },
    reply: {
      type: "string",
      description: "Respuesta breve y cordial para el paciente, en español rioplatense.",
    },
  },
};

const DATE_RE = new RegExp(DATE_PATTERN);
const BOOKING_CODE_RE = new RegExp(BOOKING_CODE_PATTERN);

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  return typeof value;
};

/**
 * Validates one parsed output object against the schema above.
 * @param {unknown} obj
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validate(obj) {
  /** @type {string[]} */
  const errors = [];

  if (!isPlainObject(obj)) {
    return { valid: false, errors: [`$: expected an object, got ${describe(obj)}`] };
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) errors.push(`${key}: required key is missing`);
  }

  for (const key of Object.keys(obj)) {
    if (!(key in outputSchema.properties)) {
      errors.push(`${key}: unexpected key (additionalProperties is false)`);
    }
  }

  if ("action" in obj) {
    const value = obj.action;
    if (typeof value !== "string") {
      errors.push(`action: expected a string, got ${describe(value)}`);
    } else if (!ACTIONS.includes(value)) {
      errors.push(`action: ${JSON.stringify(value)} is not one of ${ACTIONS.join(", ")}`);
    }
  }

  if ("specialty" in obj) {
    const value = obj.specialty;
    if (value === null) {
      // ok
    } else if (typeof value !== "string") {
      errors.push(`specialty: expected a string or null, got ${describe(value)}`);
    } else if (!SPECIALTIES.includes(value)) {
      errors.push(
        `specialty: ${JSON.stringify(value)} is not one of ${SPECIALTIES.join(", ")} or null`,
      );
    }
  }

  if ("date" in obj) {
    const value = obj.date;
    if (value === null) {
      // ok
    } else if (typeof value !== "string") {
      errors.push(`date: expected a string or null, got ${describe(value)}`);
    } else if (!DATE_RE.test(value)) {
      errors.push(`date: ${JSON.stringify(value)} does not match YYYY-MM-DD`);
    }
  }

  if ("time_window" in obj) {
    const value = obj.time_window;
    if (value === null) {
      // ok
    } else if (typeof value !== "string") {
      errors.push(`time_window: expected a string or null, got ${describe(value)}`);
    } else if (!TIME_WINDOWS.includes(value)) {
      errors.push(
        `time_window: ${JSON.stringify(value)} is not one of ${TIME_WINDOWS.join(", ")} or null`,
      );
    }
  }

  if ("booking_code" in obj) {
    const value = obj.booking_code;
    if (value === null) {
      // ok
    } else if (typeof value !== "string") {
      errors.push(`booking_code: expected a string or null, got ${describe(value)}`);
    } else if (!BOOKING_CODE_RE.test(value)) {
      errors.push(`booking_code: ${JSON.stringify(value)} does not match RS-####`);
    }
  }

  if ("reply" in obj && typeof obj.reply !== "string") {
    errors.push(`reply: expected a string, got ${describe(obj.reply)}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convenience wrapper: an object with all six keys, filled with the emptiest
 * legal values. Useful to build a full object out of a partial `expect`.
 */
export function emptyOutput() {
  return {
    action: "clarify",
    specialty: null,
    date: null,
    time_window: null,
    booking_code: null,
    reply: "",
  };
}
