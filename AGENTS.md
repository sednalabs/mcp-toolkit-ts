# TypeScript MCP Toolkit Guidelines

This document defines the engineering and documentation standards for `mcp-toolkit-ts`.
Our goal is **High-Trust, Low-Noise**. We leverage TypeScript's type system for safety and use documentation to explain *why*, not just *what*.

## 1. Documentation Policy

We adhere to the **Lean Docstring Policy** (`docs/docstring-policy.md`).

### Module-Level Documentation
Every entrypoint (`index.ts`) and major file MUST start with a context block (using `/** */` comments).
*   **Rationale**: Why does this module exist?
*   **Security Boundaries**: What data does it trust? What does it sanitize?
*   **References**: Links to Specs or Design Docs.

### Item-Level Documentation
Public functions, classes, and types focus on **usage**, **safety**, and **correctness**.
*   **# Security**: **Mandatory** for any function handling tokens, credentials, or sanitization.
*   **# Notes**: Invariants, side effects, or performance constraints.

## 2. Engineering Standards

*   **Type Safety**: Avoid `any` and `as type` assertions where possible. Use `unknown` and type narrowing.
*   **Immutability**: Prefer returning new objects/arrays over mutating inputs.
*   **Async**: Use `async/await` consistently.
*   **Dependencies**: Keep them shallow.

## The Principle of an Elegant Solution

An elegant solution is a simple, clever, and highly effective way to solve a problem, using the
minimum necessary resources (code, parts, or steps) to achieve a significant outcome. It often
solves related problems without brute force or unnecessary complexity, and it stays easy to
understand, maintain, and adapt. It prioritizes clarity, efficiency, and innovation over
brute-force methods, representing a high ratio of problem complexity to solution simplicity. A
truly elegant solution is more than just functional or safe; it is a system that is simple,
resilient, and self-sustaining. It does not merely solve a problem--it creates a framework that
prevents the problem from recurring. When approaching a task, especially a large-scale refactoring
or a new architectural design, strive for this level of elegance by considering the following:

1.  **From Static to Living:** Do not just build a static structure; cultivate a living system that
    can adapt and heal itself. The solution should not be a one-time event but a permanent,
    self-sustaining workflow.
2.  **Internalize Logic:** The system itself should be the primary agent of change and enforcement.
    Instead of relying on external scripts to police the structure, build tools that internalize
    the logic and guide contributors toward the correct path.
3.  **Incremental and Anti-Fragile:** Avoid "big bang" changes that concentrate risk or require
    brute-force effort. Design processes that are incremental, atomic, and reversible. The system
    should be anti-fragile, meaning it is resilient to failure and becomes stronger through small,
    contained corrections.
4.  **Clarity Through Tooling:** A well-designed tool is better than a page of instructions. An
    elegant solution provides tools that make the right way the easiest way, offering helpful
    guidance and automating complex tasks.
5.  **Aligns with Human Intuition:** An elegant solution ensures its physical reality matches its
    logical ideal. It should be as clear and intuitive to a human browsing the file system as it is
    to the automated tools that govern it. It reduces cognitive load and makes the correct path
    the most natural one.

By adhering to this principle, we create solutions that are not only robust and maintainable but also feel inevitable and simple to future contributors.
