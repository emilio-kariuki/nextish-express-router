import { z } from "zod";

const name = z.string().trim().min(1).max(100);
const title = z.string().trim().min(1).max(200);
const hasChanges = (value: object) => Object.keys(value).length > 0;

export const createUserSchema = z.strictObject({
  name,
  email: z.string().trim().email().max(254).toLowerCase(),
});
export const updateUserSchema = createUserSchema.partial().refine(hasChanges, "Provide at least one field");

export const createProjectSchema = z.strictObject({ name });
export const updateProjectSchema = createProjectSchema.partial().refine(hasChanges, "Provide at least one field");

export const createTodoSchema = z.strictObject({ title });
export const updateTodoSchema = z.strictObject({ title, completed: z.boolean() })
  .partial().refine(hasChanges, "Provide at least one field");
export const todoQuerySchema = z.strictObject({
  completed: z.enum(["true", "false"]).transform(value => value === "true").optional(),
});
