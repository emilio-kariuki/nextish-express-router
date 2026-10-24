import type { RouteDefinition } from "../../../../../../../src";
import { zodRoute } from "../../../../../../../src/zod";
import { getStore } from "../../../../../store";
import { createProjectSchema } from "../../../../../schemas";

export const docs = { tags: ["Projects"] };

export const GET: RouteDefinition = {
  docs: { summary: "List a user's projects", responses: { "200": { description: "Projects" } } },
  handler(req, res) {
    res.json(getStore(req).listProjects(req.params.userId));
  },
};

export const POST = zodRoute({
  schemas: { body: createProjectSchema },
  docs: { summary: "Create a project", responses: { "201": { description: "Created project" } } },
  handler(req, res) {
    const project = getStore(req).createProject(req.params.userId, req.validated.body);
    res.location(`${req.baseUrl}/users/${project.userId}/projects/${project.id}`).status(201).json(project);
  },
});
