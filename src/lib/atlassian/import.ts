import { db } from "@/lib/db";
import type { JiraStory } from "./jira";

/** The Story columns a live Jira issue fills in — shared by project import and single-story automation. */
export function storyFields(s: JiraStory) {
  return {
    jiraId: s.id,
    jiraUrl: s.url,
    issueType: s.issueType,
    title: s.summary,
    description: s.description,
    acceptanceCriteria: JSON.stringify(s.acceptanceCriteria),
    points: s.storyPoints,
    tagsJson: JSON.stringify(s.labels),
    contextJson: JSON.stringify({
      status: s.status,
      priority: s.priority,
      sprint: s.sprint,
      parent: s.parent,
      components: s.components,
      fixVersions: s.fixVersions,
      testCriteria: s.testCriteria,
      comments: s.comments,
      linkedTests: s.linkedTests,
      updated: s.updated,
    }),
    importedAt: new Date(),
  };
}

/**
 * The sprint that holds stories automated one at a time from Jira: "Jira · <PROJECT>".
 * Created on first use, so picking a story needs no sprint set up beforehand.
 */
export async function jiraSprintFor(workspaceId: string, projectKey: string) {
  const name = `Jira · ${projectKey}`;
  const existing = await db.sprint.findFirst({ where: { workspaceId, name } });
  if (existing) return existing;
  const now = new Date();
  return db.sprint.create({
    data: { workspaceId, name, startsAt: now, endsAt: new Date(now.getTime() + 14 * 86_400_000), status: "active" },
  });
}

/** Creates or refreshes the story from Jira, keeping its place in the sprint. */
export async function upsertJiraStory(sprintId: string, s: JiraStory, priority = 0) {
  const fields = storyFields(s);
  return db.story.upsert({
    where: { sprintId_key: { sprintId, key: s.key } },
    create: { sprintId, key: s.key, priority, ...fields },
    update: fields,
  });
}
