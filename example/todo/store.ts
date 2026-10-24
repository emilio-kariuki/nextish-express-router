import { randomUUID } from "node:crypto";
import type { Request } from "express";

export type User = { id: string; name: string; email: string };
export type Project = { id: string; userId: string; name: string };
export type Todo = { id: string; projectId: string; title: string; completed: boolean };

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class TodoStore {
  private users = new Map<string, User>();
  private projects = new Map<string, Project>();
  private todos = new Map<string, Todo>();

  constructor() {
    this.users.set("demo-user", { id: "demo-user", name: "Ada", email: "ada@example.test" });
    this.projects.set("demo-project", { id: "demo-project", userId: "demo-user", name: "Learn Nextish" });
    this.todos.set("demo-todo", { id: "demo-todo", projectId: "demo-project", title: "Try the todo API", completed: false });
  }

  listUsers(): User[] {
    return [...this.users.values()];
  }

  getUser(userId: string): User {
    const user = this.users.get(userId);
    if (!user) throw new ApiError(404, "User not found");
    return user;
  }

  createUser(input: Omit<User, "id">): User {
    this.checkEmail(input.email);
    const user = { ...input, id: randomUUID() };
    this.users.set(user.id, user);
    return user;
  }

  updateUser(userId: string, input: Partial<Omit<User, "id">>): User {
    const user = this.getUser(userId);
    if (input.email !== undefined) this.checkEmail(input.email, userId);
    return Object.assign(user, input);
  }

  deleteUser(userId: string): void {
    for (const project of this.listProjects(userId)) this.deleteProject(userId, project.id);
    this.users.delete(userId);
  }

  listProjects(userId: string): Project[] {
    this.getUser(userId);
    return [...this.projects.values()].filter(project => project.userId === userId);
  }

  getProject(userId: string, projectId: string): Project {
    this.getUser(userId);
    const project = this.projects.get(projectId);
    if (!project || project.userId !== userId) throw new ApiError(404, "Project not found");
    return project;
  }

  createProject(userId: string, input: Pick<Project, "name">): Project {
    this.getUser(userId);
    const project = { ...input, id: randomUUID(), userId };
    this.projects.set(project.id, project);
    return project;
  }

  updateProject(userId: string, projectId: string, input: Partial<Pick<Project, "name">>): Project {
    return Object.assign(this.getProject(userId, projectId), input);
  }

  deleteProject(userId: string, projectId: string): void {
    this.getProject(userId, projectId);
    for (const todo of this.todos.values()) {
      if (todo.projectId === projectId) this.todos.delete(todo.id);
    }
    this.projects.delete(projectId);
  }

  listTodos(userId: string, projectId: string, completed?: boolean): Todo[] {
    this.getProject(userId, projectId);
    return [...this.todos.values()].filter(todo =>
      todo.projectId === projectId && (completed === undefined || todo.completed === completed)
    );
  }

  getTodo(userId: string, projectId: string, todoId: string): Todo {
    this.getProject(userId, projectId);
    const todo = this.todos.get(todoId);
    if (!todo || todo.projectId !== projectId) throw new ApiError(404, "Todo not found");
    return todo;
  }

  createTodo(userId: string, projectId: string, input: Pick<Todo, "title">): Todo {
    this.getProject(userId, projectId);
    const todo = { ...input, id: randomUUID(), projectId, completed: false };
    this.todos.set(todo.id, todo);
    return todo;
  }

  updateTodo(userId: string, projectId: string, todoId: string, input: Partial<Pick<Todo, "title" | "completed">>): Todo {
    return Object.assign(this.getTodo(userId, projectId, todoId), input);
  }

  deleteTodo(userId: string, projectId: string, todoId: string): void {
    this.getTodo(userId, projectId, todoId);
    this.todos.delete(todoId);
  }

  private checkEmail(email: string, exceptUserId?: string): void {
    if ([...this.users.values()].some(user => user.email === email && user.id !== exceptUserId)) {
      throw new ApiError(409, "Email is already in use");
    }
  }
}

export function getStore(req: Request): TodoStore {
  return req.app.locals.todoStore;
}
