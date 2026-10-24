import type { RouteDefinition } from "../../../../../../../../src";
import { zodRoute } from "../../../../../../../../src/zod";
import { getStore } from "../../../../../../store";
import { updateProjectSchema } from "../../../../../../schemas";

export const docs = { tags: ["Projects"] };

export const GET: RouteDefinition = {
  docs: { summary: "Get a project", responses: { "200": { description: "Project" } } },
  handler(req, res) {
    res.json(getStore(req).getProject(req.params.userId, req.params.projectId));
  },
};

export const PATCH = zodRoute({
  schemas: { body: updateProjectSchema },
  docs: { summary: "Rename a project", bodyRequired: true, responses: { "200": { description: "Updated project" } } },
  handler(req, res) {
    res.json(getStore(req).updateProject(req.params.userId, req.params.projectId, req.validated.body));
  },
});

export const DELETE: RouteDefinition = {
  docs: { summary: "Delete a project and its todos", responses: { "204": { description: "Deleted project" } } },
  handler(req, res) {
    getStore(req).deleteProject(req.params.userId, req.params.projectId);
    res.status(204).end();
  },
};
