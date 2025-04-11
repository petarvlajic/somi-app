import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { OpenAI } from "openai"; // Make sure to install: npm install openai

// Function to extract plain text from Atlassian Document Format (ADF)
function extractTextFromADF(adf) {
  if (!adf || !adf.content || !Array.isArray(adf.content)) {
    return ""; // Return empty string if no valid content
  }

  let result = "";

  // Recursively extract text from content nodes
  function processNode(node) {
    if (node.text) {
      return node.text;
    }

    if (node.content && Array.isArray(node.content)) {
      return node.content.map(processNode).join("");
    }

    return "";
  }

  // Process each top-level paragraph or other content block
  for (const block of adf.content) {
    if (block.type === "paragraph" || block.type === "text") {
      result += processNode(block) + "\n";
    } else if (block.type === "bulletList" || block.type === "orderedList") {
      // Handle lists
      if (block.content) {
        block.content.forEach((item) => {
          if (item.type === "listItem" && item.content) {
            result += "• " + item.content.map(processNode).join("") + "\n";
          }
        });
      }
    } else if (block.content) {
      // Other block types with content
      result += block.content.map(processNode).join("") + "\n";
    }
  }

  return result.trim();
}

dotenv.config();

const app = express();
const port = 3000;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "NIHK"; // Your project key

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// CORS setup
app.use(cors());
app.use(express.json());

// Jira auth configuration
const JIRA_URL = process.env.JIRA_URL;
const JIRA_USER = process.env.JIRA_USER;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

const auth = {
  username: JIRA_USER,
  password: JIRA_API_TOKEN,
};

// Function to generate JQL from natural language
async function generateJQL(query) {
  try {
    // First, check if the query looks like a direct JIRA issue key
    const issueKeyPattern = new RegExp(`^\\s*${PROJECT_KEY}-\\d+\\s*$`, "i");
    if (issueKeyPattern.test(query)) {
      // If it matches the pattern of a JIRA key, return a direct key query
      const cleanKey = query.trim();
      console.log("Direct issue key detected:", cleanKey);
      return `key = "${cleanKey}"`;
    }

    // Check if the query contains a JIRA issue key within it
    const containsIssueKey = new RegExp(`${PROJECT_KEY}-\\d+`, "i");
    const matches = query.match(containsIssueKey);
    if (matches && matches.length > 0) {
      const issueKey = matches[0];
      console.log("Issue key found in query:", issueKey);
      return `key = "${issueKey}"`;
    }

    // If not a direct issue key query, proceed with AI-based JQL generation
    const systemPrompt = `
      You are a specialized AI that converts natural language into Jira Query Language (JQL).
      
      IMPORTANT: Always add "project = ${PROJECT_KEY}" to all JQL queries unless specifically told to search across all projects.
      
      Common conversions:
      - Questions about "open/opened tasks" → status in ("Open", "In Progress", "To Do", "Reopened")
      - Questions about "closed/completed tasks" → status in ("Done", "Closed", "Resolved")
      - Questions about specific people → assignee = "Person's Name"
      - Questions about priority → priority in ("High", "Highest")
      - Questions about recent activity → updated >= -7d
      
      Additional rules:
      - Return ONLY the JQL query, nothing else
      - Use double quotes for field values with spaces
      - Don't include explanations or markdown formatting
      - For status-related queries, always include all relevant statuses (e.g., include "To Do", "Open", "In Progress" for open tasks)
      - For time-based queries like "recent", use updated >= -7d
      - If the query is asking about "blockers", look for issues with priority = "Highest" OR status = "Blocked" OR labels = "blocker"
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4", // Or specify a specific version like "gpt-4-0125-preview"
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Convert this to JQL: "${query}"` },
      ],
      temperature: 0.1, // Lower temperature for more consistent results
    });

    const jqlQuery = response.choices[0].message.content.trim();
    console.log("Generated JQL:", jqlQuery);
    return jqlQuery;
  } catch (error) {
    console.error("Error generating JQL:", error);
    return `project = ${PROJECT_KEY}`; // Fallback to basic query
  }
}

// Function to analyze the user's query intent
async function analyzeQueryIntent(query) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `
            You classify Jira-related questions into specific intent categories. 
            Return only one of these categories:
            - PROJECT_STATUS (overall project progress, statistics, health)
            - TASK_LIST (listing tasks with various filters)
            - ASSIGNED_TASKS (who is working on what)
            - TASK_DETAILS (information about specific tasks)
            - BLOCKERS (issues or impediments)
            - TIMELINE (deadlines, due dates, milestones)
            - COMMENTS (looking for comments or updates)
            - GENERAL (general questions that don't fit other categories)
          `,
        },
        { role: "user", content: query },
      ],
      temperature: 0.1,
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error analyzing query intent:", error);
    return "GENERAL";
  }
}

// Function to generate a human-friendly response based on Jira data
async function generateResponse(query, jiraData, intent) {
  // Basic data checks
  if (!jiraData || !jiraData.issues) {
    return "I couldn't find any relevant information for your query.";
  }

  const issueCount = jiraData.issues.length;
  const totalCount = jiraData.total;

  try {
    const systemPrompt = `
      You are a professional project assistant for Jira data. Format your responses to be:
      - Concise but informative
      - Bullet points for lists
      - Always use data from the provided Jira response
      - For numbers and statistics, provide the exact counts
      - If the data shows zero results, explain that no matching items were found
      - Don't mention the JQL query or technical details unless specifically asked
      - If there are more results than what's provided, mention there are X more items
      - For PROJECT_STATUS responses, include a brief summary of open/closed tasks and any high priority items
      - For TASK_LIST, show the key, summary and status of each issue
      - For ASSIGNED_TASKS, group by assignee name
      - For BLOCKERS, emphasize high priority issues
      
      The query intent is: ${intent}
    `;

    // Prepare a condensed version of the Jira data to fit in context window
    const condensedIssues = jiraData.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || "Unknown",
      priority: issue.fields.priority?.name || "Unknown",
      assignee: issue.fields.assignee?.displayName || "Unassigned",
      created: issue.fields.created,
      updated: issue.fields.updated,
      dueDate: issue.fields.duedate || "No due date",
    }));

    const contextData = {
      query: query,
      total: jiraData.total,
      shownCount: condensedIssues.length,
      issues: condensedIssues,
    };

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Query: "${query}"\nJira data: ${JSON.stringify(contextData)}\n\nGenerate a helpful response.`,
        },
      ],
      temperature: 0.7, // Higher temperature for more natural responses
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error generating response:", error);

    // Fallback to basic response if AI generation fails
    if (issueCount === 0) {
      return "I couldn't find any issues matching your criteria.";
    }

    let response = `I found ${issueCount} issues`;
    if (totalCount > issueCount) {
      response += ` (showing ${issueCount} of ${totalCount} total)`;
    }
    response += ":\n\n";

    jiraData.issues.forEach((issue) => {
      const status = issue.fields.status?.name || "Unknown status";
      const assignee = issue.fields.assignee?.displayName || "Unassigned";
      response += `- ${issue.key}: ${issue.fields.summary} (${status}, Assigned to: ${assignee})\n`;
    });

    return response;
  }
}

// Advanced API endpoint to handle all types of queries
app.post("/api/query", async (req, res) => {
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ message: "Query is required" });
  }

  try {
    // Check if it looks like a request for a specific issue
    const issueKeyPattern = new RegExp(`${PROJECT_KEY}-\\d+`, "i");
    if (issueKeyPattern.test(query)) {
      // Extract the issue key
      const matches = query.match(issueKeyPattern);
      const issueKey = matches[0];

      try {
        // Try to fetch the specific issue first
        const issueResponse = await axios.get(`${JIRA_URL}/rest/api/3/issue/${issueKey}`, {
          params: {
            fields: "summary,status,assignee,priority,created,updated,duedate,comment,description",
          },
          auth,
        });

        // Format the issue data
        const comments = issueResponse.data.fields.comment?.comments || [];
        const latestComment = comments.length > 0 ? comments[comments.length - 1] : null;

        let commentMessage = "No comments found on this issue.";
        if (latestComment) {
          const author = latestComment.author?.displayName || "Unknown";
          const created = new Date(latestComment.created).toLocaleDateString();

          // Extract text content from complex comment body
          let commentText = "";

          if (typeof latestComment.body === "string") {
            commentText = latestComment.body;
          } else if (latestComment.body && latestComment.body.content) {
            // Handle Jira's Atlassian Document Format (ADF)
            try {
              commentText = extractTextFromADF(latestComment.body);
            } catch (e) {
              console.error("Error extracting comment text:", e);
              commentText = "Comment contains rich content that cannot be displayed in plain text. Please check directly in Jira.";
            }
          } else {
            commentText = "Comment has a format that cannot be displayed here. Please check directly in Jira.";
          }

          commentMessage = `**Latest comment** (by ${author} on ${created}):\n"${commentText}"`;
        }

        const status = issueResponse.data.fields.status?.name || "Unknown";
        const assignee = issueResponse.data.fields.assignee?.displayName || "Unassigned";
        const summary = issueResponse.data.fields.summary || "No summary";
        const priority = issueResponse.data.fields.priority?.name || "Not set";
        const created = new Date(issueResponse.data.fields.created).toLocaleDateString();
        const updated = new Date(issueResponse.data.fields.updated).toLocaleDateString();

        const formattedResponse =
          `## ${issueKey}: ${summary}\n\n` +
          `**Status**: ${status}\n` +
          `**Priority**: ${priority}\n` +
          `**Assignee**: ${assignee}\n` +
          `**Created**: ${created}\n` +
          `**Last Updated**: ${updated}\n\n` +
          `### Latest Comment\n${commentMessage}`;

        return res.json({
          message: formattedResponse,
          rawData: issueResponse.data,
          meta: {
            intent: "TASK_DETAILS",
            issueKey: issueKey,
          },
        });
      } catch (issueError) {
        console.error("Error fetching specific issue:", issueError);
        // If issue fetch fails, continue with normal query processing
      }
    }

    // Normal query flow for non-issue-specific questions
    // Step 1: Analyze the query intent
    const intent = await analyzeQueryIntent(query);
    console.log("Query intent:", intent);

    // Step 2: Generate appropriate JQL
    const jql = await generateJQL(query);

    if (!jql) {
      return res.status(400).json({ message: "Failed to generate a valid query." });
    }

    // Step 3: Execute JQL against Jira API
    const response = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
      params: {
        jql: jql,
        maxResults: 50,
        fields: "summary,status,assignee,priority,created,updated,duedate,comment",
      },
      auth,
    });

    // Step 4: Generate a natural language response
    const formattedResponse = await generateResponse(query, response.data, intent);

    // Send the response back to the frontend
    res.json({
      message: formattedResponse,
      rawData: response.data,
      meta: {
        intent: intent,
        jql: jql,
      },
    });
  } catch (error) {
    console.error("Error processing query:", error);

    // Check for specific error types
    if (error.response && error.response.status === 401) {
      return res.status(401).json({
        message: "Authentication failed. Please check your Jira credentials.",
      });
    }

    if (error.response && error.response.status === 400) {
      return res.status(400).json({
        message: "Invalid JQL query. Please try rephrasing your question.",
      });
    }

    res.status(500).json({
      message: "Sorry, I encountered an error while fetching data from Jira.",
    });
  }
});

// Additional endpoint for project summary (can be called on initial load)
app.get("/api/project-summary", async (req, res) => {
  try {
    // Get open issues count
    const openResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
      params: {
        jql: `project = ${PROJECT_KEY} AND status in ("Open", "In Progress", "To Do", "Reopened")`,
        maxResults: 0,
      },
      auth,
    });

    // Get recently updated issues
    const recentResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
      params: {
        jql: `project = ${PROJECT_KEY} AND updated >= -7d ORDER BY updated DESC`,
        maxResults: 5,
        fields: "summary,status,assignee,updated",
      },
      auth,
    });

    // Get high priority issues
    const priorityResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
      params: {
        jql: `project = ${PROJECT_KEY} AND priority in ("High", "Highest") AND status != "Done"`,
        maxResults: 5,
        fields: "summary,status,assignee,priority",
      },
      auth,
    });

    res.json({
      openCount: openResponse.data.total,
      recentIssues: recentResponse.data.issues,
      highPriorityIssues: priorityResponse.data.issues,
    });
  } catch (error) {
    console.error("Error fetching project summary:", error);
    res.status(500).json({ message: "Failed to fetch project summary" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
