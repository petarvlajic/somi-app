import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { OpenAI } from "openai";

// Improved JQL syntax validator and fixer
function sanitizeJQL(jql) {
  if (!jql) return `project = ${process.env.JIRA_PROJECT_KEY}`;

  // Replace common syntax errors
  let sanitized = jql;

  // Fix incorrect comma usage - replace commas not inside parentheses with AND
  sanitized = sanitized.replace(/,(?![^(]*\))/g, " AND ");

  // Ensure project is always specified
  if (!sanitized.includes(`project = "${process.env.JIRA_PROJECT_KEY}"`) && !sanitized.includes(`project = ${process.env.JIRA_PROJECT_KEY}`)) {
    sanitized = `project = ${process.env.JIRA_PROJECT_KEY} AND (${sanitized})`;
  }

  // Fix common operator issues
  sanitized = sanitized.replace(/\s+is\s+empty\b/gi, " is EMPTY");
  sanitized = sanitized.replace(/\s+is\s+not\s+empty\b/gi, " is not EMPTY");

  // Make sure any text values containing spaces are in quotes
  sanitized = sanitized.replace(/(\w+)\s*=\s*([^"'\s][^\s]*\s+[^\s"']*[^"'\s])/g, '$1 = "$2"');

  // Ensure reserved words are properly quoted
  const reservedWords = ["limit", "and", "or", "not", "empty", "null", "order", "by", "asc", "desc"];
  for (const word of reservedWords) {
    const regex = new RegExp(`\\b${word}\\b(?<!["'])`, "gi");
    sanitized = sanitized.replace(regex, `"${word}"`);
  }

  console.log("Sanitized JQL:", sanitized);
  return sanitized;
}

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

// Comprehensive query preprocessor with standardized forms
function preprocessQuery(query) {
  // Trim whitespace and normalize
  query = query.trim().toLowerCase();

  // Map of common query patterns to standardized forms
  const queryMappings = [
    // Project overview and health
    {
      regex: /^(?:how is|how's|what's|what is) (?:the )?project(?:'s)? (?:status|progress|going|health)/i,
      standardized: "show project status",
    },
    {
      regex: /^(?:give me|show|display) (?:the |a )?(?:project|overall) (?:status|overview|summary|health)/i,
      standardized: "show project status",
    },
    { regex: /^(?:project|status) (?:overview|health|summary)/i, standardized: "show project status" },

    // Timeline and deadlines
    { regex: /(?:timeline|schedule|roadmap|plan|calendar|deadlines)/i, standardized: "show project timeline" },
    { regex: /what(?:'s| is)? (?:coming up|planned|scheduled|due)/i, standardized: "show upcoming deadlines" },
    { regex: /what(?:'s| is)? due (?:this|next) (?:week|month)/i, standardized: "show upcoming deadlines" },
    { regex: /when (?:will|is|are) .* (?:due|finish|complete|done)/i, standardized: "show project timeline" },
    { regex: /what(?:'s| is) (?:the |our )?schedule/i, standardized: "show project timeline" },

    // Blockers and impediments
    { regex: /(?:blocker|blocking issue|impediment|what's blocking|what is blocking)/i, standardized: "show project blockers" },
    { regex: /what(?:'s| is)? (?:preventing|stopping|holding up)/i, standardized: "show project blockers" },
    { regex: /(?:risk|risks|at risk|critical issue)/i, standardized: "show high risk items" },

    // Workloads and assignments
    { regex: /who(?:'s| is) (?:working on|assigned to|responsible for)/i, standardized: "show team workload" },
    { regex: /what(?:'s| is) (?:everyone|everybody|the team) working on/i, standardized: "show team workload" },
    { regex: /(?:workload|bandwidth|capacity|allocation)/i, standardized: "show team workload" },
    { regex: /who(?:'s| is) (?:overloaded|busy|free|available)/i, standardized: "show team workload" },

    // Tasks and issues
    { regex: /(?:show|list|find|get) (?:all |the |)?(?:open|active|current) (?:tasks|issues|tickets)/i, standardized: "show open tasks" },
    {
      regex: /(?:show|list|find|get) (?:all |the |)?(?:closed|completed|done|resolved) (?:tasks|issues|tickets)/i,
      standardized: "show closed tasks",
    },
    {
      regex: /(?:show|list|find|get) (?:all |the |)?(?:high priority|important|critical) (?:tasks|issues|tickets)/i,
      standardized: "show high priority tasks",
    },
    {
      regex: /(?:show|list|find|get) (?:all |the |)?(?:unassigned|without assignee) (?:tasks|issues|tickets)/i,
      standardized: "show unassigned tasks",
    },

    // Recent activity
    { regex: /(?:recent|latest|last|newest|what's new|what is new)/i, standardized: "show recent updates" },
    { regex: /what(?:'s| has) changed/i, standardized: "show recent updates" },
    { regex: /what(?:'s| has) happened/i, standardized: "show recent updates" },

    // Sprint related
    { regex: /(?:current|active|ongoing) sprint/i, standardized: "show current sprint" },
    { regex: /sprint status/i, standardized: "show current sprint" },
    { regex: /(?:sprint|iteration) progress/i, standardized: "show current sprint" },

    // Most recent task specifically
    {
      regex: /(?:latest|most recent|last) (?:edited|updated|modified|changed) (?:task|issue|ticket)/i,
      standardized: "show most recently updated task",
    },

    // Specific task by ID
    { regex: new RegExp(`(?:show|tell me about|what is|details for|info on)\\s+${process.env.JIRA_PROJECT_KEY}-\\d+`, "i"), standardized: query },
  ];

  // Find a match and return the standardized form
  for (const mapping of queryMappings) {
    if (mapping.regex.test(query)) {
      console.log(`Standardized query from "${query}" to "${mapping.standardized}"`);
      return mapping.standardized;
    }
  }

  // If no mapping found, clean up the query a bit
  const cleanQuery = query.replace(/[.,!?;]/g, "").trim();

  return cleanQuery;
}

// Safe JQL templates for common query types
const safeJqlTemplates = {
  PROJECT_STATUS: `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY updated DESC`,
  TIMELINE: `project = ${process.env.JIRA_PROJECT_KEY} AND duedate IS NOT EMPTY ORDER BY duedate ASC`,
  TIMELINE_UPCOMING: `project = ${process.env.JIRA_PROJECT_KEY} AND duedate >= now() ORDER BY duedate ASC`,
  TIMELINE_OVERDUE: `project = ${process.env.JIRA_PROJECT_KEY} AND duedate < now() AND status != "Done" ORDER BY duedate ASC`,
  BLOCKERS: `project = ${process.env.JIRA_PROJECT_KEY} AND (priority in ("High", "Highest") OR status = "Blocked" OR labels = "blocker") AND status not in ("Done", "Closed", "Resolved")`,
  HIGH_PRIORITY: `project = ${process.env.JIRA_PROJECT_KEY} AND priority in ("High", "Highest") AND status not in ("Done", "Closed", "Resolved")`,
  OPEN_TASKS: `project = ${process.env.JIRA_PROJECT_KEY} AND status in ("Open", "In Progress", "To Do", "Reopened")`,
  CLOSED_TASKS: `project = ${process.env.JIRA_PROJECT_KEY} AND status in ("Done", "Closed", "Resolved")`,
  ASSIGNED_TASKS: `project = ${process.env.JIRA_PROJECT_KEY} AND assignee IS NOT EMPTY AND status not in ("Done", "Closed", "Resolved")`,
  UNASSIGNED_TASKS: `project = ${process.env.JIRA_PROJECT_KEY} AND assignee IS EMPTY AND status not in ("Done", "Closed", "Resolved")`,
  RECENT_UPDATES: `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY updated DESC`,
  CURRENT_SPRINT: `project = ${process.env.JIRA_PROJECT_KEY} AND sprint in openSprints()`,
  MOST_RECENT_TASK: `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY updated DESC`,
};

// Enhanced fallback JQL generator
function fallbackGenerateJQL(query, intent) {
  // Look for keywords to determine the right fallback
  query = query.toLowerCase();

  // Try to match intent to a safe template first
  if (intent === "PROJECT_STATUS") return safeJqlTemplates.PROJECT_STATUS;
  if (intent === "TIMELINE") return safeJqlTemplates.TIMELINE;
  if (intent === "BLOCKERS") return safeJqlTemplates.BLOCKERS;
  if (intent === "TASK_LIST" && /open|active|current/i.test(query)) return safeJqlTemplates.OPEN_TASKS;
  if (intent === "TASK_LIST" && /closed|completed|done|resolved/i.test(query)) return safeJqlTemplates.CLOSED_TASKS;
  if (intent === "TASK_LIST" && /high|important|critical|priority/i.test(query)) return safeJqlTemplates.HIGH_PRIORITY;
  if (intent === "TASK_LIST" && /unassigned|without assignee/i.test(query)) return safeJqlTemplates.UNASSIGNED_TASKS;
  if (intent === "ASSIGNED_TASKS") return safeJqlTemplates.ASSIGNED_TASKS;
  if (intent === "SPRINT") return safeJqlTemplates.CURRENT_SPRINT;
  if (intent === "WORKLOAD") return safeJqlTemplates.ASSIGNED_TASKS;

  // If no intent match, look for keywords in the query
  if (/timeline|deadline|due|schedule/i.test(query)) return safeJqlTemplates.TIMELINE;
  if (/blocker|blocking|impediment|risk/i.test(query)) return safeJqlTemplates.BLOCKERS;
  if (/high|priority|important|urgent|critical/i.test(query)) return safeJqlTemplates.HIGH_PRIORITY;
  if (/open|active|current/i.test(query) && /task|issue|ticket/i.test(query)) return safeJqlTemplates.OPEN_TASKS;
  if (/closed|completed|done|resolved/i.test(query)) return safeJqlTemplates.CLOSED_TASKS;
  if (/assign|work|responsible/i.test(query)) return safeJqlTemplates.ASSIGNED_TASKS;
  if (/recent|latest|new|update/i.test(query)) return safeJqlTemplates.RECENT_UPDATES;
  if (/sprint/i.test(query)) return safeJqlTemplates.CURRENT_SPRINT;

  // Default fallback
  return safeJqlTemplates.PROJECT_STATUS;
}

// Load environment variables
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

// Enhanced intent analysis for more precise query understanding
async function analyzeQueryIntent(query) {
  // First check for special patterns we can directly classify
  if (/sprint|current sprint|active sprint|sprint status|sprint board/i.test(query)) {
    return "SPRINT";
  }

  if (/^(?:hi|hello|hey|hi there|greetings|how are you|what can you do|what do you do|help me|how do you work)/i.test(query.trim())) {
    return "GREETING";
  }

  const issueKeyPattern = new RegExp(`${process.env.JIRA_PROJECT_KEY}-\\d+`, "i");
  if (issueKeyPattern.test(query) && /^(?:show|tell|get|what is|about) ${process.env.JIRA_PROJECT_KEY}-\d+$/i.test(query.trim())) {
    return "TASK_DETAILS";
  }

  // Common patterns with direct intent mapping
  if (/project.* status|status.* project|how.* project|project.* health|project.* overview/i.test(query)) {
    return "PROJECT_STATUS";
  }

  if (/timeline|roadmap|schedule|deadline|due date|what.* due|calendar|when/i.test(query)) {
    return "TIMELINE";
  }

  if (/block|blocker|blocking|stuck|impediment|obstacle|risk|critical|prevent/i.test(query)) {
    return "BLOCKERS";
  }

  if (/workload|capacity|bandwidth|overloaded|busy|who.*working|team.* work/i.test(query)) {
    return "WORKLOAD";
  }

  if (/assign|working on|responsible|owner|who is|who's/i.test(query)) {
    return "ASSIGNED_TASKS";
  }

  if (/list|show|find|search|get|all|open|closed|high/i.test(query) && /task|issue|ticket/i.test(query)) {
    return "TASK_LIST";
  }

  if (/comment|said|mentioned|update|notes/i.test(query)) {
    return "COMMENTS";
  }

  // Try AI for more complex queries
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `
            You classify Jira-related questions into specific intent categories. 
            Analyze the query carefully and return ONLY ONE of these categories:
            
            - PROJECT_STATUS: Questions about overall project health, progress, metrics
              Examples: "How's the project going?", "What's our current status?", "Give me a project overview"
              
            - TASK_LIST: Requests for lists of tasks matching certain criteria
              Examples: "Show me all open bugs", "List the high priority tasks", "What tasks are due this week?"
              
            - ASSIGNED_TASKS: Questions about who is working on what
              Examples: "What is John working on?", "Show me Sarah's tasks", "Who's responsible for the login feature?"
              
            - TASK_DETAILS: Questions about specific tickets or issues
              Examples: "Tell me about PROJ-123", "What's the status of the payment feature?", "Who's working on the homepage redesign?"
              
            - BLOCKERS: Questions about impediments or high-priority issues
              Examples: "What's blocking us?", "Are there any critical issues?", "What should we focus on fixing first?"
              
            - TIMELINE: Questions about deadlines, due dates, or project schedule
              Examples: "What's due this week?", "When will feature X be done?", "Show me upcoming deadlines"
              
            - COMMENTS: Questions looking for updates, comments, or recent activity
              Examples: "Any updates on PROJ-123?", "What did John say about the login issue?", "Latest comments on the API task?"
              
            - WORKLOAD: Questions about team capacity and individual workloads
              Examples: "Who has the most tasks?", "Is anyone overloaded?", "How's the team's capacity looking?"
              
            - SPRINT: Questions about sprint status and activity
              Examples: "How's the current sprint?", "What's in this sprint?", "Sprint progress"
              
            - GENERAL: General questions that don't fit other categories
              Examples: "Help me with Jira", "What can you do?", "How does this work?"
              
            - CONVERSATION: Follow-up questions, clarifications, or conversational exchanges
              Examples: "Can you explain more?", "Thanks for that info", "That's not what I meant"
          `,
        },
        { role: "user", content: query },
      ],
      temperature: 0.1,
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error analyzing query intent:", error);

    // Fallback intent detection based on keywords
    if (/timeline|roadmap|schedule|deadline|due date|what.* due|calendar|when/i.test(query)) {
      return "TIMELINE";
    } else if (/block|blocker|blocking|stuck|impediment|obstacle|risk|critical/i.test(query)) {
      return "BLOCKERS";
    } else if (/assign|working on|responsible|owner|who is|who's/i.test(query)) {
      return "ASSIGNED_TASKS";
    } else if (/status|progress|update|how is|how's|overview/i.test(query)) {
      return "PROJECT_STATUS";
    } else if (/list|show|find|search|get|all/i.test(query)) {
      return "TASK_LIST";
    } else if (/comment|said|mentioned|update|notes/i.test(query)) {
      return "COMMENTS";
    } else if (/workload|capacity|bandwidth|overloaded|busy/i.test(query)) {
      return "WORKLOAD";
    } else if (/sprint/i.test(query)) {
      return "SPRINT";
    } else {
      return "GENERAL";
    }
  }
}

// Enhanced JQL generator with more nuanced query understanding
async function generateJQL(query, intent) {
  try {
    // First, check for pre-defined templates based on standardized queries
    if (query === "show project status") return safeJqlTemplates.PROJECT_STATUS;
    if (query === "show project timeline") return safeJqlTemplates.TIMELINE;
    if (query === "show upcoming deadlines") return safeJqlTemplates.TIMELINE_UPCOMING;
    if (query === "show project blockers") return safeJqlTemplates.BLOCKERS;
    if (query === "show high risk items") return safeJqlTemplates.HIGH_PRIORITY;
    if (query === "show team workload") return safeJqlTemplates.ASSIGNED_TASKS;
    if (query === "show open tasks") return safeJqlTemplates.OPEN_TASKS;
    if (query === "show closed tasks") return safeJqlTemplates.CLOSED_TASKS;
    if (query === "show high priority tasks") return safeJqlTemplates.HIGH_PRIORITY;
    if (query === "show unassigned tasks") return safeJqlTemplates.UNASSIGNED_TASKS;
    if (query === "show recent updates") return safeJqlTemplates.RECENT_UPDATES;
    if (query === "show current sprint") return safeJqlTemplates.CURRENT_SPRINT;
    if (query === "show most recently updated task") return safeJqlTemplates.MOST_RECENT_TASK;

    // Check for specific issue key
    const issueKeyPattern = new RegExp(`^\\s*${process.env.JIRA_PROJECT_KEY}-\\d+\\s*$`, "i");
    if (issueKeyPattern.test(query)) {
      const cleanKey = query.trim();
      console.log("Direct issue key detected:", cleanKey);
      return `key = "${cleanKey}"`;
    }

    // Check if the query contains a JIRA issue key within it
    const containsIssueKey = new RegExp(`${process.env.JIRA_PROJECT_KEY}-\\d+`, "i");
    const matches = query.match(containsIssueKey);
    if (matches && matches.length > 0) {
      const issueKey = matches[0];
      console.log("Issue key found in query:", issueKey);
      return `key = "${issueKey}"`;
    }

    // Use intent-based templates for some common intents
    if (intent === "CONVERSATION" || intent === "GREETING") {
      return safeJqlTemplates.RECENT_UPDATES;
    }

    if (intent === "SPRINT") {
      return safeJqlTemplates.CURRENT_SPRINT;
    }

    if (intent === "PROJECT_STATUS") {
      return safeJqlTemplates.PROJECT_STATUS;
    }

    // Special case for recent/latest task queries
    if (/recent|latest|most recent|last|newest/i.test(query) && /edited|updated|modified|changed|task/i.test(query)) {
      return safeJqlTemplates.MOST_RECENT_TASK;
    }

    // Enhanced system prompt for JQL generation
    const systemPrompt = `
      You are a specialized AI that converts natural language into precise Jira Query Language (JQL).
      Your task is to generate ONLY valid JQL that will work correctly with Jira.
      
      VERY IMPORTANT RULES:
      1. Always add "project = ${process.env.JIRA_PROJECT_KEY}" to all JQL queries unless specifically told to search across all projects
      2. Return ONLY the JQL query, nothing else. No explanations or additional text.
      3. ALWAYS use double quotes for field values containing spaces
      4. NEVER use commas outside of parentheses except in IN clauses - use AND or OR instead
      5. NEVER use "LIMIT" in JQL - if quantity limiting is needed, use ORDER BY instead
      6. For queries about recent/latest items, use "ORDER BY updated DESC" or "ORDER BY created DESC"
      7. Ensure all special characters and reserved words are properly escaped
      8. For multiple values in an IN statement, format like: status IN ("Open", "In Progress")
      9. Avoid complex syntax with unclear operators
      10. Avoid any syntax that might cause this error: "Expecting operator but got ','"
      
      Common valid JQL patterns:
      - status = "In Progress"
      - assignee = "John Doe"
      - project = "${process.env.JIRA_PROJECT_KEY}" AND status IN ("Open", "In Progress")
      - project = "${process.env.JIRA_PROJECT_KEY}" AND priority = "High" AND assignee IS NOT EMPTY
      - project = "${process.env.JIRA_PROJECT_KEY}" AND labels = "frontend" AND status != "Done"
      - project = "${process.env.JIRA_PROJECT_KEY}" AND created >= -7d
      
      FORBIDDEN PATTERNS:
      - AVOID: status = open, assignee = john  ← NO COMMAS between conditions, missing quotes
      - AVOID: status = "open", updated = "2023-01-01"  ← NO COMMAS between conditions
      - AVOID: project, status = open  ← Invalid syntax, missing operators
      - AVOID: LIMIT 5  ← Never use LIMIT keyword
      - AVOID: ORDER BY status DESC LIMIT 10  ← Never use LIMIT keyword
      
      CORRECT PATTERNS:
      - project = "${process.env.JIRA_PROJECT_KEY}" AND status = "Open" AND assignee = "John"
      - project = "${process.env.JIRA_PROJECT_KEY}" AND (status = "Open" OR status = "In Progress")
      - project = "${process.env.JIRA_PROJECT_KEY}" AND status IN ("Open", "In Progress")
      
      Generate a valid JQL query based on the user's intent: ${intent} and query: "${query}".
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Convert this to precise JQL: "${query}"` },
      ],
      temperature: 0.1, // Lower temperature for consistent results
    });

    let jqlQuery = response.choices[0].message.content.trim();
    console.log("Generated JQL:", jqlQuery);

    // Apply safety checks and sanitization to the AI-generated JQL
    const sanitizedJQL = sanitizeJQL(jqlQuery);

    return sanitizedJQL;
  } catch (error) {
    console.error("Error generating JQL:", error);
    // Use the enhanced fallback JQL generator
    return fallbackGenerateJQL(query, intent);
  }
}

// Special handler for most recently edited task
async function getMostRecentTaskDetails(req, res, query, sessionId) {
  try {
    // Get the most recently updated task
    const recentTaskResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
      params: {
        jql: `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY updated DESC`,
        maxResults: 1,
        fields: "summary,status,assignee,priority,created,updated,duedate,comment,description",
      },
      auth,
    });

    if (recentTaskResponse.data && recentTaskResponse.data.issues && recentTaskResponse.data.issues.length > 0) {
      const issue = recentTaskResponse.data.issues[0];
      const status = issue.fields.status?.name || "Unknown";
      const assignee = issue.fields.assignee?.displayName || "Unassigned";
      const summary = issue.fields.summary || "No summary";
      const priority = issue.fields.priority?.name || "Not set";
      const created = new Date(issue.fields.created).toLocaleDateString();
      const updated = new Date(issue.fields.updated).toLocaleDateString();

      // Description handling
      let description = "No description provided.";
      if (issue.fields.description) {
        if (typeof issue.fields.description === "string") {
          description = issue.fields.description;
        } else if (issue.fields.description.content) {
          try {
            description = extractTextFromADF(issue.fields.description);
          } catch (e) {
            description = "Description contains rich formatting that cannot be displayed in plain text.";
          }
        }
      }

      // Comment handling
      const comments = issue.fields.comment?.comments || [];
      let commentMessage = "No comments found on this issue.";
      if (comments.length > 0) {
        const latestComment = comments[comments.length - 1];
        const author = latestComment.author?.displayName || "Unknown";
        const commentCreated = new Date(latestComment.created).toLocaleDateString();
        let commentText = "";

        if (typeof latestComment.body === "string") {
          commentText = latestComment.body;
        } else if (latestComment.body && latestComment.body.content) {
          try {
            commentText = extractTextFromADF(latestComment.body);
          } catch (e) {
            commentText = "Comment contains rich content that cannot be displayed in plain text.";
          }
        }

        commentMessage = `**Latest comment** (by ${author} on ${commentCreated}):\n"${commentText}"`;
      }

      const formattedResponse =
        `## ${issue.key}: ${summary} (Most Recently Updated)\n\n` +
        `**Status**: ${status}\n` +
        `**Priority**: ${priority}\n` +
        `**Assignee**: ${assignee}\n` +
        `**Created**: ${created}\n` +
        `**Last Updated**: ${updated}\n\n` +
        `### Description\n${description}\n\n` +
        `### Latest Comment\n${commentMessage}`;

      // Store response in conversation memory
      if (conversationMemory[sessionId]) {
        conversationMemory[sessionId].lastResponse = formattedResponse;
      }

      return res.json({
        message: formattedResponse,
        rawData: issue,
        meta: {
          intent: "TASK_DETAILS",
          issueKey: issue.key,
        },
      });
    }
    return null; // Continue with normal processing if no issues found
  } catch (error) {
    console.error("Error fetching most recent task:", error);
    return null; // Continue with normal processing
  }
}

// Special handler for project status overview
async function getProjectStatusOverview(req, res, sessionId) {
  try {
    // Get key project metrics in parallel
    const [openResponse, inProgressResponse, doneResponse, highPriorityResponse, blockedResponse, unassignedResponse, recentResponse] =
      await Promise.all([
        // Open issues
        axios.get(`${JIRA_URL}/rest/api/3/search`, {
          params: {
            jql: `project = ${process.env.JIRA_PROJECT_KEY} AND status = "Open"`,
            maxResults: 0,
          },
          auth,
        }),

        // In Progress issues
        axios.get(`${JIRA_URL}/rest/api/3/search`, {
          params: {
            jql: `project = ${process.env.JIRA_PROJECT_KEY} AND status = "In Progress"`,
            maxResults: 0,
          },
          auth,
        }),

        // Done issues
        axios.get(`${JIRA_URL}/rest/api/3/search`, {
          params: {
            jql: `project = ${process.env.JIRA_PROJECT_KEY} AND status = "Done"`,
            maxResults: 0,
          },
          auth,
        }),

        // High priority issues
        axios.get(`${JIRA_URL}/rest/api/3/search`, {
          params: {
            jql: `project = ${process.env.JIRA_PROJECT_KEY} AND priority in ("High", "Highest") AND status != "Done"`,
            maxResults: 5,
            fields: "summary,status,assignee,priority",
          },
          auth,
        }),

        // Blocked issues
        axios.get(`${JIRA_URL}/rest/api/3/search`, {
          params: {
            jql: `project = ${process.env.JIRA_PROJECT_KEY} AND (status = "Blocked" OR labels = "blocker")`,
            maxResults: 5,
            fields: "summary,status,assignee,priority",
          },
          auth,
        }),

        // Unassigned issues
        axios.get(`${JIRA_URL}/rest/api/3/search`, {
          params: {
            jql: `project = ${process.env.JIRA_PROJECT_KEY} AND assignee IS EMPTY AND status != "Done"`,
            maxResults: 5,
            fields: "summary,status,priority",
          },
          auth,
        }),

        // Recently updated issues
        axios.get(`${JIRA_URL}/rest/api/3/search`, {
          params: {
            jql: `project = ${process.env.JIRA_PROJECT_KEY} AND updated >= -7d ORDER BY updated DESC`,
            maxResults: 5,
            fields: "summary,status,updated,assignee",
          },
          auth,
        }),
      ]);

    // Compile the data
    const statusData = {
      openCount: openResponse.data.total,
      inProgressCount: inProgressResponse.data.total,
      doneCount: doneResponse.data.total,
      totalCount: openResponse.data.total + inProgressResponse.data.total + doneResponse.data.total,
      highPriorityIssues: highPriorityResponse.data.issues,
      highPriorityCount: highPriorityResponse.data.total,
      blockedIssues: blockedResponse.data.issues,
      blockedCount: blockedResponse.data.total,
      unassignedIssues: unassignedResponse.data.issues,
      unassignedCount: unassignedResponse.data.total,
      recentIssues: recentResponse.data.issues,
      recentCount: recentResponse.data.total,
    };

    // Calculate percentages for better insights
    const completionPercentage = Math.round((statusData.doneCount / statusData.totalCount) * 100) || 0;

    try {
      // Generate a conversational response using AI
      const prompt = `
        You are a helpful project assistant providing a project status overview. 
        You should be conversational, insightful and friendly.
        
        Here is data about the current project:
        - Open tasks: ${statusData.openCount}
        - Tasks in progress: ${statusData.inProgressCount}
        - Completed tasks: ${statusData.doneCount}
        - Project completion: ${completionPercentage}%
        - High priority issues: ${statusData.highPriorityCount}
        - Blocked issues: ${statusData.blockedCount}
        - Unassigned issues: ${statusData.unassignedCount}
        - Recent updates: ${statusData.recentCount} in the last 7 days
        
        Craft a brief, conversational summary of the project status that gives the key highlights.
        Include relevant insights based on the numbers.
        Format important information in bold using markdown (**bold**).
        Use bullet points sparingly, and only when it helps readability.
      `;

      const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: "Give me a friendly project status overview" },
        ],
        temperature: 0.7,
      });

      // Start with the AI-generated project overview
      let formattedResponse = response.choices[0].message.content;

      // Add high priority issues if there are any
      if (statusData.highPriorityIssues.length > 0) {
        formattedResponse += "\n\n### High Priority Issues\n";
        for (const issue of statusData.highPriorityIssues.slice(0, 3)) {
          const priority = issue.fields.priority?.name || "High";
          const assignee = issue.fields.assignee?.displayName || "Unassigned";
          formattedResponse += `• ${issue.key}: ${issue.fields.summary} (${priority}, assigned to ${assignee})\n`;
        }

        if (statusData.highPriorityCount > 3) {
          formattedResponse += `... and ${statusData.highPriorityCount - 3} more high priority issues.\n`;
        }
      }

      // Add blocked issues if there are any
      if (statusData.blockedIssues.length > 0) {
        formattedResponse += "\n\n### Blocked Issues\n";
        for (const issue of statusData.blockedIssues.slice(0, 3)) {
          const assignee = issue.fields.assignee?.displayName || "Unassigned";
          formattedResponse += `• ${issue.key}: ${issue.fields.summary} (assigned to ${assignee})\n`;
        }

        if (statusData.blockedCount > 3) {
          formattedResponse += `... and ${statusData.blockedCount - 3} more blocked issues.\n`;
        }
      }

      // Store in conversation memory
      if (conversationMemory[sessionId]) {
        conversationMemory[sessionId].lastResponse = formattedResponse;
      }

      return res.json({
        message: formattedResponse,
        rawData: statusData,
        meta: {
          intent: "PROJECT_STATUS",
        },
      });
    } catch (aiError) {
      console.error("Error generating AI project status:", aiError);

      // Fallback to a formatted response without AI
      let formattedResponse = `## Project Status Overview\n\n`;
      formattedResponse += `**Current progress**: ${completionPercentage}% complete\n`;
      formattedResponse += `**Open tasks**: ${statusData.openCount}\n`;
      formattedResponse += `**In progress**: ${statusData.inProgressCount}\n`;
      formattedResponse += `**Completed**: ${statusData.doneCount}\n\n`;

      if (statusData.highPriorityCount > 0) {
        formattedResponse += `**High priority issues**: ${statusData.highPriorityCount}\n`;
      }

      if (statusData.blockedCount > 0) {
        formattedResponse += `**Blocked issues**: ${statusData.blockedCount}\n`;
      }

      if (statusData.unassignedCount > 0) {
        formattedResponse += `**Unassigned tasks**: ${statusData.unassignedCount}\n`;
      }

      formattedResponse += `\n### Recent Activity\n`;
      for (const issue of statusData.recentIssues.slice(0, 3)) {
        const status = issue.fields.status?.name || "Unknown";
        const updated = new Date(issue.fields.updated).toLocaleDateString();
        formattedResponse += `• ${issue.key}: ${issue.fields.summary} (${status}, updated on ${updated})\n`;
      }

      // Store in conversation memory
      if (conversationMemory[sessionId]) {
        conversationMemory[sessionId].lastResponse = formattedResponse;
      }

      return res.json({
        message: formattedResponse,
        rawData: statusData,
        meta: {
          intent: "PROJECT_STATUS",
        },
      });
    }
  } catch (error) {
    console.error("Error fetching project status:", error);
    return null; // Continue with normal processing
  }
}

// Special handler for timeline queries
async function getProjectTimeline(req, res, query, sessionId) {
  try {
    // Determine timeline type
    let timeframeDesc = "upcoming";
    let jql = "";

    if (/past|previous|last|recent/i.test(query)) {
      timeframeDesc = "past";
      jql = `project = ${process.env.JIRA_PROJECT_KEY} AND duedate <= now() AND duedate >= -30d ORDER BY duedate DESC`;
    } else if (/overdue|late|miss(ed)?|behind/i.test(query)) {
      timeframeDesc = "overdue";
      jql = `project = ${process.env.JIRA_PROJECT_KEY} AND duedate < now() AND status != "Done" ORDER BY duedate ASC`;
    } else if (/this week|current week/i.test(query)) {
      timeframeDesc = "this week";
      jql = `project = ${process.env.JIRA_PROJECT_KEY} AND duedate >= startOfWeek() AND duedate <= endOfWeek() ORDER BY duedate ASC`;
    } else if (/next week/i.test(query)) {
      timeframeDesc = "next week";
      jql = `project = ${process.env.JIRA_PROJECT_KEY} AND duedate > endOfWeek() AND duedate <= endOfWeek(1) ORDER BY duedate ASC`;
    } else if (/this month|current month/i.test(query)) {
      timeframeDesc = "this month";
      jql = `project = ${process.env.JIRA_PROJECT_KEY} AND duedate >= startOfMonth() AND duedate <= endOfMonth() ORDER BY duedate ASC`;
    } else {
      // Default to upcoming timeline
      jql = `project = ${process.env.JIRA_PROJECT_KEY} AND duedate >= now() ORDER BY duedate ASC`;
    }

    // Execute timeline query
    const timelineResponse = await axios
      .get(`${JIRA_URL}/rest/api/3/search`, {
        params: {
          jql: jql,
          maxResults: 20,
          fields: "summary,status,assignee,priority,duedate",
        },
        auth,
      })
      .catch((error) => {
        console.error("Timeline JQL failed:", error);
        // Try a simpler fallback
        return axios.get(`${JIRA_URL}/rest/api/3/search`, {
          params: {
            jql: `project = ${process.env.JIRA_PROJECT_KEY} AND duedate IS NOT EMPTY ORDER BY duedate ASC`,
            maxResults: 20,
            fields: "summary,status,assignee,priority,duedate",
          },
          auth,
        });
      });

    if (timelineResponse.data && timelineResponse.data.issues && timelineResponse.data.issues.length > 0) {
      // Group issues by date
      const issuesByDate = {};
      const allIssues = timelineResponse.data.issues;

      allIssues.forEach((issue) => {
        if (!issue.fields.duedate) return;

        const dueDate = new Date(issue.fields.duedate);

        // Format by month and year
        const dateKey = dueDate.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        });

        if (!issuesByDate[dateKey]) {
          issuesByDate[dateKey] = [];
        }

        issuesByDate[dateKey].push(issue);
      });

      // Try to use AI to create a natural response
      try {
        const timelineData = {
          timeframe: timeframeDesc,
          totalDueDatesCount: allIssues.length,
          timelineGroups: Object.entries(issuesByDate).map(([date, issues]) => ({
            date,
            count: issues.length,
            examples: issues.slice(0, 5).map((issue) => ({
              key: issue.key,
              summary: issue.fields.summary,
              status: issue.fields.status?.name || "Unknown",
              priority: issue.fields.priority?.name || "Unknown",
              assignee: issue.fields.assignee?.displayName || "Unassigned",
            })),
          })),
        };

        const prompt = `
          You are a helpful Jira assistant providing timeline information about a project.
          
          Create a conversational, helpful response about the ${timeframeDesc} timeline.
          Organize information by date and highlight important upcoming deadlines.
          
          Make your response conversational and easy to read, not just a list of data.
          Use markdown formatting, especially for grouping items by date.
          Limit details to what's necessary - be concise but informative.
        `;

        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: `Timeline data: ${JSON.stringify(timelineData)}` },
          ],
          temperature: 0.7,
        });

        const formattedResponse = aiResponse.choices[0].message.content;

        // Store in conversation memory
        if (conversationMemory[sessionId]) {
          conversationMemory[sessionId].lastResponse = formattedResponse;
        }

        return res.json({
          message: formattedResponse,
          meta: {
            intent: "TIMELINE",
            timeframe: timeframeDesc,
          },
        });
      } catch (aiError) {
        console.error("Error generating AI timeline:", aiError);

        // Fallback to a simpler format
        let formattedResponse = `## Project Timeline (${timeframeDesc})\n\n`;

        if (Object.keys(issuesByDate).length === 0) {
          formattedResponse += "No issues with due dates found in this timeframe.";
        } else {
          Object.entries(issuesByDate).forEach(([dateGroup, issues]) => {
            formattedResponse += `### ${dateGroup}\n`;

            issues.slice(0, 5).forEach((issue) => {
              const status = issue.fields.status?.name || "Unknown";
              const assignee = issue.fields.assignee?.displayName || "Unassigned";
              const date = new Date(issue.fields.duedate).toLocaleDateString();

              formattedResponse += `• ${issue.key}: ${issue.fields.summary} (Due: ${date}, ${status}, Assigned to: ${assignee})\n`;
            });

            if (issues.length > 5) {
              formattedResponse += `... and ${issues.length - 5} more items due in ${dateGroup}.\n`;
            }

            formattedResponse += "\n";
          });
        }

        // Store in conversation memory
        if (conversationMemory[sessionId]) {
          conversationMemory[sessionId].lastResponse = formattedResponse;
        }

        return res.json({
          message: formattedResponse,
          meta: {
            intent: "TIMELINE",
            timeframe: timeframeDesc,
          },
        });
      }
    }

    return null; // Continue with normal processing if no issues
  } catch (error) {
    console.error("Error handling timeline query:", error);
    return null; // Continue with normal processing
  }
}

// Special handler for team workload
async function getTeamWorkload(req, res, query, sessionId) {
  try {
    // Get assignments for all team members
    const workloadResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
      params: {
        jql: `project = ${process.env.JIRA_PROJECT_KEY} AND assignee IS NOT EMPTY AND status != "Done"`,
        maxResults: 100,
        fields: "summary,status,assignee,priority",
      },
      auth,
    });

    if (workloadResponse.data && workloadResponse.data.issues && workloadResponse.data.issues.length > 0) {
      // Group issues by assignee
      const issuesByAssignee = {};
      const issues = workloadResponse.data.issues;

      issues.forEach((issue) => {
        const assignee = issue.fields.assignee?.displayName || "Unassigned";

        if (!issuesByAssignee[assignee]) {
          issuesByAssignee[assignee] = [];
        }

        issuesByAssignee[assignee].push(issue);
      });

      // Try to use AI to create a natural response
      try {
        const workloadData = {
          totalActiveIssues: issues.length,
          teamMembers: Object.entries(issuesByAssignee).map(([name, tasks]) => ({
            name,
            taskCount: tasks.length,
            highPriorityCount: tasks.filter((t) => t.fields.priority?.name === "Highest" || t.fields.priority?.name === "High").length,
            examples: tasks.slice(0, 3).map((task) => ({
              key: task.key,
              summary: task.fields.summary,
              status: task.fields.status?.name,
              priority: task.fields.priority?.name,
            })),
          })),
        };

        // Sort team members by workload
        workloadData.teamMembers.sort((a, b) => b.taskCount - a.taskCount);

        const prompt = `
          You are a helpful Jira assistant analyzing team workload distribution.
          
          Create a conversational response about the team's current workload.
          Highlight who has the most work, who has high priority items, and any imbalances.
          
          Be helpful and insightful, not just listing raw data.
          Use markdown for formatting, especially for grouping by team member.
          Be concise but provide meaningful insights about the workload distribution.
        `;

        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: `Team workload data: ${JSON.stringify(workloadData)}` },
          ],
          temperature: 0.7,
        });

        const formattedResponse = aiResponse.choices[0].message.content;

        // Store in conversation memory
        if (conversationMemory[sessionId]) {
          conversationMemory[sessionId].lastResponse = formattedResponse;
        }

        return res.json({
          message: formattedResponse,
          meta: {
            intent: "WORKLOAD",
          },
        });
      } catch (aiError) {
        console.error("Error generating AI workload:", aiError);

        // Fallback to a simpler format
        let formattedResponse = `## Team Workload Overview\n\n`;

        // Sort assignees by workload
        const sortedAssignees = Object.entries(issuesByAssignee).sort((a, b) => b[1].length - a[1].length);

        formattedResponse += `Currently there are **${issues.length} active tasks** assigned across **${sortedAssignees.length} team members**.\n\n`;

        sortedAssignees.forEach(([assignee, tasks]) => {
          const highPriorityCount = tasks.filter((t) => t.fields.priority?.name === "Highest" || t.fields.priority?.name === "High").length;

          formattedResponse += `### ${assignee}\n`;
          formattedResponse += `**Total tasks**: ${tasks.length}`;

          if (highPriorityCount > 0) {
            formattedResponse += ` (${highPriorityCount} high priority)`;
          }

          formattedResponse += `\n\n`;

          // Show examples of their tasks
          tasks.slice(0, 3).forEach((task) => {
            const status = task.fields.status?.name || "Unknown";
            const priority = task.fields.priority?.name || "";

            formattedResponse += `• ${task.key}: ${task.fields.summary} (${status}`;
            if (priority) formattedResponse += `, ${priority}`;
            formattedResponse += `)\n`;
          });

          if (tasks.length > 3) {
            formattedResponse += `... and ${tasks.length - 3} more tasks.\n`;
          }

          formattedResponse += `\n`;
        });

        // Store in conversation memory
        if (conversationMemory[sessionId]) {
          conversationMemory[sessionId].lastResponse = formattedResponse;
        }

        return res.json({
          message: formattedResponse,
          meta: {
            intent: "WORKLOAD",
          },
        });
      }
    }

    return null; // Continue with normal processing if no issues
  } catch (error) {
    console.error("Error handling workload query:", error);
    return null; // Continue with normal processing
  }
}

// Enhanced response generation function with better conversational capabilities
async function generateResponse(query, jiraData, intent, context = {}) {
  // Basic data checks
  if (!jiraData || !jiraData.issues) {
    return "I couldn't find any relevant information for your query.";
  }

  const issueCount = jiraData.issues.length;
  const totalCount = jiraData.total;

  // Handle greeting and conversational intents specially
  if (intent === "GREETING") {
    const greetingResponses = [
      "Hi there! I'm your Jira assistant. I can help you with:\n\n• Finding tasks and issues\n• Checking project status\n• Understanding who's working on what\n• Tracking blockers and high-priority items\n• Monitoring deadlines and timelines\n\nJust ask me a question about your Jira project!",

      "Hello! I'm here to help you navigate your Jira project. You can ask me about:\n\n• Open and closed tasks\n• Task assignments and ownership\n• Project timelines and deadlines\n• High priority issues and blockers\n• Recent updates and changes\n\nWhat would you like to know about your project today?",

      'Hey! I\'m your Jira chatbot assistant. Some things you can ask me:\n\n• "What\'s the status of our project?"\n• "Show me open bugs assigned to Sarah"\n• "Any blockers in the current sprint?"\n• "Tell me about NIHK-123"\n• "What\'s due this week?"\n\nHow can I help you today?',
    ];

    return greetingResponses[Math.floor(Math.random() * greetingResponses.length)];
  }

  if (intent === "CONVERSATION") {
    // Pull out recent project activity for conversational context
    const recentActivity = jiraData.issues.slice(0, 3).map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || "Unknown",
    }));

    const conversationPrompt = `
      You are a friendly Jira assistant chatting with a user. The user has said: "${query}"
      
      This appears to be a conversational follow-up rather than a direct query about Jira data.
      
      Some recent activity in the project includes:
      ${recentActivity.map((i) => `- ${i.key}: ${i.summary} (${i.status})`).join("\n")}
      
      Respond in a friendly, helpful way. If they're asking for more information or clarification,
      offer to help them by suggesting specific types of queries they could ask. If they're
      expressing appreciation, acknowledge it warmly and ask if they need anything else.
      
      Don't fabricate Jira data that wasn't provided. Make your response conversational and natural.
    `;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          { role: "system", content: conversationPrompt },
          { role: "user", content: query },
        ],
        temperature: 0.7,
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      console.error("Error generating conversational response:", error);
      return "I'm here to help with your Jira queries. What would you like to know about your project?";
    }
  }

  try {
    // Create a more varied and context-aware system prompt based on intent
    let systemPrompt = `
      You are a helpful, friendly Jira project assistant providing information in a conversational, natural tone.
      
      Format requirements for the frontend:
      - Use markdown formatting that works with the frontend:
        - ## for main headers (issue keys)
        - ### for section headers
        - **bold** for field names and important information
        - • or - for bullet points
        - Line breaks to separate sections
    `;

    // Add intent-specific guidance
    if (intent === "PROJECT_STATUS") {
      systemPrompt += `
        For PROJECT_STATUS intent:
        - Begin with a conversational summary of the project's current state
        - Highlight key metrics (open issues, in progress, completed)
        - Mention any critical or high priority items
        - Add insights about progress and bottlenecks
        - Organize information in a clear, scannable way
      `;
    } else if (intent === "TASK_LIST") {
      systemPrompt += `
        For TASK_LIST intent:
        - Start with a brief overview of the results ("I found X tasks...")
        - Group tasks logically (by status, priority, etc.)
        - For each task, include the key, summary, status and assignee
        - Limit to showing 5-7 tasks with a note about the rest
        - Add a brief insight about the tasks if possible
      `;
    } else if (intent === "ASSIGNED_TASKS") {
      systemPrompt += `
        For ASSIGNED_TASKS intent:
        - Group tasks by assignee
        - For each person, list 2-3 of their most important tasks
        - Include task key, summary and status
        - Add a brief comment about each person's workload
        - Highlight any potential overloading or imbalances
      `;
    } else if (intent === "TASK_DETAILS") {
      systemPrompt += `
        For TASK_DETAILS intent:
        - Use a clear header with the issue key and summary
        - Organize details into logical sections
        - Include all important fields (status, priority, assignee, dates)
        - Format description and comments for readability
        - Highlight the most recent or important information
      `;
    } else if (intent === "BLOCKERS") {
      systemPrompt += `
        For BLOCKERS intent:
        - Use slightly urgent language appropriate for blockers
        - Clearly identify the most critical issues first
        - For each blocker, include who it's assigned to and its status
        - Group by priority if there are multiple blockers
        - Suggest possible next steps if appropriate
      `;
    } else if (intent === "TIMELINE") {
      systemPrompt += `
        For TIMELINE intent:
        - Organize items chronologically
        - Group by timeframe (this week, next week, this month)
        - Highlight upcoming deadlines
        - Include due dates, current status, and assignees
        - Add context about timing and priorities
      `;
    } else if (intent === "COMMENTS") {
      systemPrompt += `
        For COMMENTS intent:
        - Show the most recent comments first
        - Include the author and date for each comment
        - Format the comment text for readability
        - Provide context around what the comment is referring to
        - Highlight important points from the comments
      `;
    } else if (intent === "WORKLOAD") {
      systemPrompt += `
        For WORKLOAD intent:
        - Compare team members' workloads
        - Show who has the most and least tasks
        - Highlight who has high priority items
        - Note any potential overloading
        - Suggest workload balancing if needed
      `;
    } else if (intent === "SPRINT") {
      systemPrompt += `
        For SPRINT intent:
        - Provide an overview of the current sprint status
        - Group issues by status (to do, in progress, done)
        - Highlight progress (% complete, days remaining)
        - Note any blockers or at-risk items
        - Keep the tone conversational and insightful
      `;
    }

    systemPrompt += `
      General guidelines:
      - Maintain a conversational, helpful tone throughout
      - Begin with a direct response to their query, then provide supporting details
      - Keep lists concise - show 5 items max and summarize the rest if there are more
      - Show Jira issue keys in their original format (${process.env.JIRA_PROJECT_KEY}-123) 
      - Vary your language patterns and openings to sound natural
      - Add relevant insights beyond just listing data
      - Include specific counts and metrics when available
      - Adjust your tone based on the urgency/priority of the issues
      - Never mention JQL or technical implementation details
      - End with a brief, helpful question or suggestion if appropriate

      The query intent is: ${intent}
      The user asked: "${query}"
    `;

    // Prepare a condensed version of the Jira data
    const condensedIssues = jiraData.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || "Unknown",
      priority: issue.fields.priority?.name || "Unknown",
      assignee: issue.fields.assignee?.displayName || "Unassigned",
      created: issue.fields.created,
      updated: issue.fields.updated,
      dueDate: issue.fields.duedate || "No due date",
      comments:
        issue.fields.comment?.comments?.length > 0
          ? {
              count: issue.fields.comment.comments.length,
              latest: {
                author: issue.fields.comment.comments[issue.fields.comment.comments.length - 1].author?.displayName || "Unknown",
                created: issue.fields.comment.comments[issue.fields.comment.comments.length - 1].created,
                body:
                  typeof issue.fields.comment.comments[issue.fields.comment.comments.length - 1].body === "string"
                    ? issue.fields.comment.comments[issue.fields.comment.comments.length - 1].body.substring(0, 150) + "..."
                    : "Complex formatted comment",
              },
            }
          : null,
    }));

    // Add analysis of the query and data to provide context
    const queryAnalysis = {
      seemsUrgent: /urgent|asap|immediately|critical|blocker/i.test(query),
      mentionsTime: /due date|deadline|when|timeline|schedule|milestone/i.test(query),
      mentionsPerson: /assigned to|working on|responsible for/i.test(query),
      isSpecific: /specific|exactly|precisely|only/i.test(query),
      requestsCount: /how many|count|number of/i.test(query),
    };

    // Calculate basic statistics to enrich the response
    const statistics = {
      statusBreakdown: condensedIssues.reduce((acc, issue) => {
        acc[issue.status] = (acc[issue.status] || 0) + 1;
        return acc;
      }, {}),
      priorityBreakdown: condensedIssues.reduce((acc, issue) => {
        acc[issue.priority] = (acc[issue.priority] || 0) + 1;
        return acc;
      }, {}),
      assigneeBreakdown: condensedIssues.reduce((acc, issue) => {
        const assignee = issue.assignee || "Unassigned";
        acc[assignee] = (acc[assignee] || 0) + 1;
        return acc;
      }, {}),
    };

    // Add conversation context if available
    const conversationContext = context.previousQueries ? { previousQueries: context.previousQueries.slice(-3) } : {};

    const contextData = {
      query,
      total: jiraData.total,
      shownCount: condensedIssues.length,
      issues: condensedIssues,
      queryAnalysis,
      statistics,
      ...conversationContext,
    };

    // Use a higher temperature for more varied responses
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Query: "${query}"\nJira data: ${JSON.stringify(contextData)}\n\nGenerate a helpful, conversational response.`,
        },
      ],
      temperature: 0.7, // Higher temperature for more varied responses
      max_tokens: 800, // Ensure we get a full, detailed response
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error generating response:", error);

    // Enhanced fallback responses based on intent
    // This ensures that even if AI fails, we provide a relevant, helpful response

    if (issueCount === 0) {
      const noResultsResponses = [
        "I couldn't find any issues matching your criteria. Would you like to try a different search?",
        "I looked, but didn't find any matching issues in Jira. Could you try rephrasing your question?",
        "No results found for that query. Maybe we could try a broader search?",
        "I don't see any issues that match what you're looking for. Let me know if you'd like to try a different approach.",
      ];
      return noResultsResponses[Math.floor(Math.random() * noResultsResponses.length)];
    }

    // Intent-specific fallback responses
    if (intent === "PROJECT_STATUS") {
      let response = `## Project Status Overview\n\n`;

      // Calculate basic statistics
      const statusCounts = {};
      jiraData.issues.forEach((issue) => {
        const status = issue.fields.status?.name || "Unknown";
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      });

      // Add status breakdown
      response += `Here's the current status of the project:\n\n`;
      for (const [status, count] of Object.entries(statusCounts)) {
        response += `• **${status}**: ${count} issues\n`;
      }

      // Add recent activity
      response += `\n### Recent Activity\n`;
      for (let i = 0; i < Math.min(3, issueCount); i++) {
        const issue = jiraData.issues[i];
        const status = issue.fields.status?.name || "Unknown";
        response += `• ${issue.key}: ${issue.fields.summary} (${status})\n`;
      }

      return response;
    }

    if (intent === "TIMELINE") {
      let response = `## Project Timeline\n\n`;

      // Group by due date (month)
      const issuesByMonth = {};
      jiraData.issues.forEach((issue) => {
        if (!issue.fields.duedate) return;

        const dueDate = new Date(issue.fields.duedate);
        const month = dueDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

        if (!issuesByMonth[month]) {
          issuesByMonth[month] = [];
        }

        issuesByMonth[month].push(issue);
      });

      // Format timeline
      if (Object.keys(issuesByMonth).length === 0) {
        response += "I didn't find any issues with due dates in the timeline.";
      } else {
        for (const [month, issues] of Object.entries(issuesByMonth)) {
          response += `### ${month}\n`;

          issues.forEach((issue) => {
            const status = issue.fields.status?.name || "Unknown";
            const dueDate = new Date(issue.fields.duedate).toLocaleDateString();
            response += `• ${issue.key}: ${issue.fields.summary} (Due: ${dueDate}, ${status})\n`;
          });

          response += "\n";
        }
      }

      return response;
    }

    if (intent === "BLOCKERS" || intent === "HIGH_PRIORITY") {
      let response = `## Key Issues Requiring Attention\n\n`;

      const priorityCounts = {};
      jiraData.issues.forEach((issue) => {
        const priority = issue.fields.priority?.name || "Unknown";
        priorityCounts[priority] = (priorityCounts[priority] || 0) + 1;
      });

      response += `I found ${issueCount} issues that need attention:\n\n`;

      // Group by priority
      jiraData.issues.forEach((issue) => {
        const priority = issue.fields.priority?.name || "Unknown";
        const status = issue.fields.status?.name || "Unknown";
        const assignee = issue.fields.assignee?.displayName || "Unassigned";

        response += `• **${issue.key}**: ${issue.fields.summary} (${priority}, ${status}, Assigned to: ${assignee})\n`;
      });

      return response;
    }

    if (intent === "ASSIGNED_TASKS" || intent === "WORKLOAD") {
      let response = `## Team Workload\n\n`;

      // Group by assignee
      const issuesByAssignee = {};
      jiraData.issues.forEach((issue) => {
        const assignee = issue.fields.assignee?.displayName || "Unassigned";

        if (!issuesByAssignee[assignee]) {
          issuesByAssignee[assignee] = [];
        }

        issuesByAssignee[assignee].push(issue);
      });

      // Format by assignee
      for (const [assignee, issues] of Object.entries(issuesByAssignee)) {
        response += `### ${assignee} (${issues.length} issues)\n`;

        issues.slice(0, 3).forEach((issue) => {
          const status = issue.fields.status?.name || "Unknown";
          response += `• ${issue.key}: ${issue.fields.summary} (${status})\n`;
        });

        if (issues.length > 3) {
          response += `... and ${issues.length - 3} more issues.\n`;
        }

        response += "\n";
      }

      return response;
    }

    // Default fallback for other intents
    // Group by status for better organization
    const issuesByStatus = {};
    jiraData.issues.forEach((issue) => {
      const status = issue.fields.status?.name || "Unknown";
      if (!issuesByStatus[status]) {
        issuesByStatus[status] = [];
      }
      issuesByStatus[status].push(issue);
    });

    // Choose a varied opening phrase
    const openingPhrases = [
      `I found ${issueCount} issues related to your query.`,
      `There are ${issueCount} issues that match what you're looking for.`,
      `Your search returned ${issueCount} issues.`,
      `I've located ${issueCount} relevant issues in the project.`,
      `Looking at your query, I found ${issueCount} matching issues.`,
    ];

    let response = openingPhrases[Math.floor(Math.random() * openingPhrases.length)];
    if (totalCount > issueCount) {
      response += ` (Out of ${totalCount} total in the project)`;
    }
    response += `\n\n`;

    // Format in a more readable way
    for (const [status, issues] of Object.entries(issuesByStatus)) {
      response += `**${status}**:\n`;
      issues.forEach((issue) => {
        const assignee = issue.fields.assignee?.displayName || "Unassigned";
        response += `• ${issue.key}: ${issue.fields.summary} (Assigned to: ${assignee})\n`;
      });
      response += "\n";
    }

    // Varied closing prompts
    const closingPrompts = [
      "Is there a specific issue you'd like to know more about?",
      "Would you like details about any of these issues?",
      "Let me know if you need more information on any particular issue.",
      "I can tell you more about any of these issues if you're interested.",
      "Would you like to dive deeper into any of these?",
    ];

    response += closingPrompts[Math.floor(Math.random() * closingPrompts.length)];

    return response;
  }
}

// Store conversation context
const conversationMemory = {};

// Advanced API endpoint to handle all types of queries with conversation memory
// Advanced API endpoint to handle all types of queries with conversation memory
app.post("/api/query", async (req, res) => {
  let { query, sessionId = "default" } = req.body;

  if (!query) {
    return res.status(400).json({ message: "Query is required" });
  }

  // Initialize session memory if it doesn't exist
  if (!conversationMemory[sessionId]) {
    conversationMemory[sessionId] = {
      queries: [],
      intents: [],
      lastResponse: null,
    };
  }

  // Add to conversation memory
  conversationMemory[sessionId].queries.push(query);
  if (conversationMemory[sessionId].queries.length > 10) {
    conversationMemory[sessionId].queries.shift(); // Keep only the 10 most recent
  }

  try {
    // Preprocess the query to handle common problematic patterns
    const originalQuery = query;
    const preprocessedQuery = preprocessQuery(query);
    if (preprocessedQuery !== originalQuery) {
      console.log(`Preprocessed query from "${originalQuery}" to "${preprocessedQuery}"`);
      query = preprocessedQuery;
    }

    // Special handling for common query types

    // Most recently updated task
    if (query === "show most recently updated task") {
      const result = await getMostRecentTaskDetails(req, res, query, sessionId);
      if (result) return; // If handled successfully, stop processing
    }

    // Project status overview
    if (query === "show project status") {
      const result = await getProjectStatusOverview(req, res, sessionId);
      if (result) return; // If handled successfully, stop processing
    }

    // Timeline queries
    if (query === "show project timeline" || query === "show upcoming deadlines") {
      const result = await getProjectTimeline(req, res, query, sessionId);
      if (result) return; // If handled successfully, stop processing
    }

    // Team workload queries
    if (query === "show team workload") {
      const result = await getTeamWorkload(req, res, query, sessionId);
      if (result) return; // If handled successfully, stop processing
    }

    // Step 1: Analyze the query intent
    const intent = await analyzeQueryIntent(query);
    console.log("Query intent:", intent);

    // Store intent in conversation memory
    conversationMemory[sessionId].intents.push(intent);
    if (conversationMemory[sessionId].intents.length > 10) {
      conversationMemory[sessionId].intents.shift();
    }

    // For greeting or purely conversational responses, handle differently
    if (intent === "GREETING") {
      const greetingResponses = [
        "Hi there! I'm your Jira assistant. I can help you with:\n\n• Finding tasks and issues\n• Checking project status\n• Understanding who's working on what\n• Tracking blockers and high-priority items\n• Monitoring deadlines and timelines\n\nJust ask me a question about your Jira project!",

        "Hello! I'm here to help you navigate your Jira project. You can ask me about:\n\n• Open and closed tasks\n• Task assignments and ownership\n• Project timelines and deadlines\n• High priority issues and blockers\n• Recent updates and changes\n\nWhat would you like to know about your project today?",

        'Hey! I\'m your Jira chatbot assistant. Some things you can ask me:\n\n• "What\'s the status of our project?"\n• "Show me open bugs assigned to Sarah"\n• "Any blockers in the current sprint?"\n• "Tell me about NIHK-123"\n• "What\'s due this week?"\n\nHow can I help you today?',
      ];

      const response = greetingResponses[Math.floor(Math.random() * greetingResponses.length)];

      // Store response
      conversationMemory[sessionId].lastResponse = response;

      return res.json({
        message: response,
        meta: {
          intent: "GREETING",
        },
      });
    }

    // Special handling for sprint queries
    if (intent === "SPRINT") {
      try {
        // Get active sprints first
        const activeSprintsResponse = await axios
          .get(`${JIRA_URL}/rest/agile/1.0/board/active`, {
            auth,
          })
          .catch((err) => {
            console.log("Error fetching active boards:", err.message);
            return { data: { values: [] } };
          });

        let sprintData = [];
        let sprintName = "current sprint";

        // If we found active sprints, get details for the first one
        if (activeSprintsResponse.data && activeSprintsResponse.data.values && activeSprintsResponse.data.values.length > 0) {
          const firstBoard = activeSprintsResponse.data.values[0];

          // Get sprints for this board
          const sprintsResponse = await axios
            .get(`${JIRA_URL}/rest/agile/1.0/board/${firstBoard.id}/sprint?state=active`, {
              auth,
            })
            .catch((err) => {
              console.log("Error fetching sprints:", err.message);
              return { data: { values: [] } };
            });

          if (sprintsResponse.data && sprintsResponse.data.values && sprintsResponse.data.values.length > 0) {
            const activeSprint = sprintsResponse.data.values[0];
            sprintName = activeSprint.name;

            // Get issues for this sprint
            const sprintIssuesResponse = await axios
              .get(`${JIRA_URL}/rest/agile/1.0/sprint/${activeSprint.id}/issue`, {
                params: {
                  fields: "summary,status,assignee,priority,issuetype",
                },
                auth,
              })
              .catch((err) => {
                console.log("Error fetching sprint issues:", err.message);
                return { data: { issues: [] } };
              });

            if (sprintIssuesResponse.data && sprintIssuesResponse.data.issues) {
              sprintData = sprintIssuesResponse.data.issues;
            }
          }
        }

        // If no active sprint found through agile API, fall back to JQL
        if (sprintData.length === 0) {
          const fallbackResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
            params: {
              jql: `project = ${process.env.JIRA_PROJECT_KEY} AND sprint in openSprints()`,
              maxResults: 50,
              fields: "summary,status,assignee,priority,issuetype",
            },
            auth,
          });

          if (fallbackResponse.data && fallbackResponse.data.issues) {
            sprintData = fallbackResponse.data.issues;
          }
        }

        // Generate a natural, conversational response about the sprint
        const systemPrompt = `
          You are a friendly Jira assistant talking about sprint status. Create a conversational response about 
          the ${sprintName} that feels natural and helpful, not like a database query result.
          
          Guidelines:
          - Start with a personable opening about the sprint
          - Group issues by status in a way that feels natural
          - Highlight the most important issues (highest priority ones)
          - Add meaningful insights about progress, not just statistics
          - Keep the tone conversational, like a helpful colleague
          - Include a brief closing with a question about what they'd like to know next
          - Use appropriate emoji sparingly to make it more engaging (📊, 🚀, 🏃‍♀️, etc.)
          
          Format guidelines:
          - Avoid bullet points that just list issues
          - Don't create tables
          - Organize information in conversational paragraphs
          - Create a response someone would actually speak, not a report
        `;

        // Prepare the data
        const statusGroups = {};
        const assigneeGroups = {};
        const typeGroups = {};

        sprintData.forEach((issue) => {
          // Group by status
          const status = issue.fields.status?.name || "Unknown";
          if (!statusGroups[status]) statusGroups[status] = [];
          statusGroups[status].push(issue);

          // Group by assignee
          const assignee = issue.fields.assignee?.displayName || "Unassigned";
          if (!assigneeGroups[assignee]) assigneeGroups[assignee] = [];
          assigneeGroups[assignee].push(issue);

          // Group by issue type
          const issueType = issue.fields.issuetype?.name || "Unknown";
          if (!typeGroups[issueType]) typeGroups[issueType] = [];
          typeGroups[issueType].push(issue);
        });

        // High priority issues
        const highPriorityIssues = sprintData.filter(
          (issue) => issue.fields.priority?.name === "Highest" || issue.fields.priority?.name === "High"
        );

        const sprintContext = {
          sprintName,
          totalIssues: sprintData.length,
          statusGroups: Object.entries(statusGroups).map(([status, issues]) => ({
            status,
            count: issues.length,
            examples: issues.slice(0, 3).map((i) => ({
              key: i.key,
              summary: i.fields.summary,
              assignee: i.fields.assignee?.displayName || "Unassigned",
            })),
          })),
          assigneeGroups: Object.entries(assigneeGroups)
            .filter(([assignee, issues]) => assignee !== "Unassigned")
            .map(([assignee, issues]) => ({
              assignee,
              count: issues.length,
            })),
          highPriorityIssues: highPriorityIssues.slice(0, 3).map((i) => ({
            key: i.key,
            summary: i.fields.summary,
            status: i.fields.status?.name || "Unknown",
            assignee: i.fields.assignee?.displayName || "Unassigned",
          })),
          issueTypes: Object.entries(typeGroups).map(([type, issues]) => ({
            type,
            count: issues.length,
          })),
        };

        try {
          // Generate the natural response
          const sprintResponse = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `Generate a natural, conversational response about the sprint with this data: ${JSON.stringify(sprintContext)}`,
              },
            ],
            temperature: 0.7, // Higher for more varied, natural responses
          });

          const formattedResponse = sprintResponse.choices[0].message.content.trim();

          // Store the response
          conversationMemory[sessionId].lastResponse = formattedResponse;

          return res.json({
            message: formattedResponse,
            meta: {
              intent: "SPRINT",
              sprintName,
              issueCount: sprintData.length,
            },
          });
        } catch (aiError) {
          console.error("Error generating sprint response with AI:", aiError);

          // Fallback sprint response without AI
          const doneCount = statusGroups["Done"]?.length || 0;
          const inProgressCount = statusGroups["In Progress"]?.length || 0;
          const todoCount = statusGroups["To Do"]?.length || 0;

          let formattedResponse = `I'm looking at the ${sprintName} sprint. `;

          if (sprintData.length === 0) {
            formattedResponse += "I don't see any issues in this sprint yet.";
          } else {
            formattedResponse += `There are ${sprintData.length} issues in this sprint. `;
            formattedResponse += `Current progress: ${doneCount} completed, ${inProgressCount} in progress, and ${todoCount} still to do.\n\n`;

            if (highPriorityIssues.length > 0) {
              formattedResponse += `There are ${highPriorityIssues.length} high priority issues to focus on.\n\n`;

              // Include a couple examples
              if (highPriorityIssues.length > 0) {
                const example = highPriorityIssues[0];
                formattedResponse += `For example, ${example.key}: "${example.fields.summary}" is a high priority task currently ${
                  example.fields.status?.name || "in unknown status"
                }.\n\n`;
              }
            }

            // Add information about team distribution
            const assigneesCount = Object.keys(assigneeGroups).filter((name) => name !== "Unassigned").length;
            formattedResponse += `${assigneesCount} team members are working on tasks in this sprint.`;
          }

          return res.json({
            message: formattedResponse,
            meta: {
              intent: "SPRINT",
              sprintName,
              issueCount: sprintData.length,
            },
          });
        }
      } catch (sprintError) {
        console.error("Error fetching sprint data:", sprintError);
        // Fall back to normal query processing
      }
    }

    // Check if it looks like a request for a specific issue
    const issueKeyPattern = new RegExp(`${process.env.JIRA_PROJECT_KEY}-\\d+`, "i");
    if (issueKeyPattern.test(query)) {
      // Extract the issue key
      const matches = query.match(issueKeyPattern);
      const issueKey = matches[0];

      try {
        // Try to fetch the specific issue
        const issueResponse = await axios.get(`${JIRA_URL}/rest/api/3/issue/${issueKey}`, {
          params: {
            fields: "summary,status,assignee,priority,created,updated,duedate,comment,description,labels,issuelinks",
          },
          auth,
        });

        // Format the issue data
        const issue = issueResponse.data;
        const comments = issue.fields.comment?.comments || [];
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

        // For simple lookups, use a direct response
        if (intent === "TASK_DETAILS" && /^(?:show|tell|get|what is|about)\s+${issueKey}$/i.test(query.trim())) {
          const status = issue.fields.status?.name || "Unknown";
          const assignee = issue.fields.assignee?.displayName || "Unassigned";
          const summary = issue.fields.summary || "No summary";
          const priority = issue.fields.priority?.name || "Not set";
          const created = new Date(issue.fields.created).toLocaleDateString();
          const updated = new Date(issue.fields.updated).toLocaleDateString();

          // Description handling
          let description = "No description provided.";
          if (issue.fields.description) {
            if (typeof issue.fields.description === "string") {
              description = issue.fields.description;
            } else if (issue.fields.description.content) {
              try {
                description = extractTextFromADF(issue.fields.description);
              } catch (e) {
                description = "Description contains rich formatting that cannot be displayed in plain text.";
              }
            }
          }

          const formattedResponse =
            `## ${issueKey}: ${summary}\n\n` +
            `**Status**: ${status}\n` +
            `**Priority**: ${priority}\n` +
            `**Assignee**: ${assignee}\n` +
            `**Created**: ${created}\n` +
            `**Last Updated**: ${updated}\n\n` +
            `### Description\n${description}\n\n` +
            `### Latest Comment\n${commentMessage}`;

          // Store response in conversation memory
          conversationMemory[sessionId].lastResponse = formattedResponse;

          return res.json({
            message: formattedResponse,
            rawData: issue,
            meta: {
              intent: "TASK_DETAILS",
              issueKey: issueKey,
            },
          });
        } else {
          try {
            // For more complex queries about an issue, use AI to generate a tailored response
            const systemPrompt = `
              You are a friendly Jira assistant. You've been asked about the task ${issueKey}: "${query}".
              The user's intent appears to be: ${intent}.
              
              Create a response that addresses their specific question about this issue, while providing 
              the relevant information from the task. Format your response using markdown that will work with 
              the frontend:
              - Use ## for the issue title
              - Use ### for section headers
              - Use **bold** for field names
              - Use • or - for bullet points
              - Organize your response into logical sections
              - Make your response conversational and helpful

              Based on the intent "${intent}", focus on the most relevant details of the issue.
              Previous conversation context (if available):
              ${conversationMemory[sessionId].queries
                .slice(-3)
                .map((q) => `- User: ${q}`)
                .join("\n")}
            `;

            // Prepare the issue data in a more accessible format
            const taskData = {
              key: issue.key,
              summary: issue.fields.summary,
              status: issue.fields.status?.name || "Unknown",
              priority: issue.fields.priority?.name || "Unknown",
              assignee: issue.fields.assignee?.displayName || "Unassigned",
              created: issue.fields.created,
              updated: issue.fields.updated,
              dueDate: issue.fields.duedate || "No due date",
              description:
                typeof issue.fields.description === "string" ? issue.fields.description : extractTextFromADF(issue.fields.description),
              comments: comments.map((c) => ({
                author: c.author?.displayName || "Unknown",
                created: c.created,
                body: typeof c.body === "string" ? c.body : extractTextFromADF(c.body),
              })),
              labels: issue.fields.labels || [],
              issueLinks: issue.fields.issuelinks || [],
            };

            const aiResponse = await openai.chat.completions.create({
              model: "gpt-4",
              messages: [
                { role: "system", content: systemPrompt },
                {
                  role: "user",
                  content: `Issue details: ${JSON.stringify(taskData)}. Generate a response to the query: "${query}"`,
                },
              ],
              temperature: 0.7,
            });

            const formattedResponse = aiResponse.choices[0].message.content.trim();

            // Store response in conversation memory
            conversationMemory[sessionId].lastResponse = formattedResponse;

            return res.json({
              message: formattedResponse,
              rawData: issue,
              meta: {
                intent,
                issueKey,
              },
            });
          } catch (aiError) {
            console.error("Error generating AI response for issue:", aiError);

            // Fallback to a simpler format if AI fails
            const status = issue.fields.status?.name || "Unknown";
            const assignee = issue.fields.assignee?.displayName || "Unassigned";
            const summary = issue.fields.summary || "No summary";
            const priority = issue.fields.priority?.name || "Not set";

            // Create a simplified response
            const formattedResponse =
              `## ${issueKey}: ${summary}\n\n` +
              `Here's what you asked about this issue:\n\n` +
              `**Status**: ${status}\n` +
              `**Priority**: ${priority}\n` +
              `**Assignee**: ${assignee}\n\n` +
              `${commentMessage}`;

            // Store response in conversation memory
            conversationMemory[sessionId].lastResponse = formattedResponse;

            return res.json({
              message: formattedResponse,
              rawData: issue,
              meta: {
                intent,
                issueKey,
              },
            });
          }
        }
      } catch (issueError) {
        console.error("Error fetching specific issue:", issueError);
        // If issue fetch fails, continue with normal query processing
      }
    }

    // For conversational follow-ups, handle specially
    if (intent === "CONVERSATION") {
      // Get some basic project info for context
      try {
        const recentIssuesResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
          params: {
            jql: `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY updated DESC`,
            maxResults: 5,
            fields: "summary,status,assignee,updated",
          },
          auth,
        });

        // Use the conversational handler
        const formattedResponse = await generateResponse(query, recentIssuesResponse.data, intent, {
          previousQueries: conversationMemory[sessionId].queries,
        });

        // Store response
        conversationMemory[sessionId].lastResponse = formattedResponse;

        return res.json({
          message: formattedResponse,
          meta: { intent: "CONVERSATION" },
        });
      } catch (error) {
        console.error("Error handling conversational query:", error);

        // Fallback for conversation
        const conversationalResponses = [
          "I'm here to help with your Jira project. Could you ask me something specific about your tasks or project status?",
          "I'd be happy to help you with your Jira project. What would you like to know about your issues or project?",
          "I can provide information about your Jira tasks, assignments, deadlines, and more. What are you looking for?",
          "I'm your Jira assistant. I can tell you about task status, assignments, priorities, and more. What would you like to know?",
        ];

        const formattedResponse = conversationalResponses[Math.floor(Math.random() * conversationalResponses.length)];

        // Store response
        conversationMemory[sessionId].lastResponse = formattedResponse;

        return res.json({
          message: formattedResponse,
          meta: { intent: "CONVERSATION" },
        });
      }
    }

    // Step 2: Generate JQL based on the analyzed intent
    let jql;
    try {
      jql = await generateJQL(query, intent);
    } catch (jqlError) {
      console.error("Error generating JQL:", jqlError);
      // Use a fallback based on intent
      jql = fallbackGenerateJQL(query, intent);
    }

    if (!jql) {
      return res.status(400).json({ message: "Failed to generate a valid query." });
    }

    // Step 3: Determine relevant fields based on the query intent
    let fields = "summary,status,assignee,priority,created,updated,duedate";

    // Add specific fields based on intent
    if (intent === "COMMENTS") {
      fields += ",comment";
    }
    if (intent === "TIMELINE") {
      fields += ",duedate,created,updated";
    }
    if (intent === "BLOCKERS") {
      fields += ",issuelinks,labels";
    }
    if (intent === "TASK_DETAILS") {
      fields += ",comment,description,issuelinks,labels";
    }
    if (intent === "WORKLOAD") {
      fields += ",assignee";
    }
    if (intent === "SPRINT") {
      fields += ",sprint";
    }

    // Step 4: Execute JQL against Jira API with customized field selection
    // Set a reasonable limit on results
    const maxResults = intent === "TASK_LIST" || intent === "ASSIGNED_TASKS" ? 20 : 50;

    let jiraResponse;
    try {
      jiraResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
        params: {
          jql: jql,
          maxResults: maxResults,
          fields,
        },
        auth,
      });
    } catch (jqlError) {
      console.error("JQL error:", jqlError.message);

      // Try to recover with a simplified query based on intent
      let simplifiedJQL;

      // Choose an appropriate fallback for each intent
      if (intent === "PROJECT_STATUS") {
        simplifiedJQL = safeJqlTemplates.PROJECT_STATUS;
      } else if (intent === "TIMELINE") {
        simplifiedJQL = safeJqlTemplates.TIMELINE;
      } else if (intent === "BLOCKERS" || intent === "HIGH_PRIORITY") {
        simplifiedJQL = safeJqlTemplates.HIGH_PRIORITY;
      } else if (intent === "TASK_LIST" && /open|active/i.test(query)) {
        simplifiedJQL = safeJqlTemplates.OPEN_TASKS;
      } else if (intent === "TASK_LIST" && /closed|done|completed/i.test(query)) {
        simplifiedJQL = safeJqlTemplates.CLOSED_TASKS;
      } else if (intent === "ASSIGNED_TASKS" || intent === "WORKLOAD") {
        simplifiedJQL = safeJqlTemplates.ASSIGNED_TASKS;
      } else if (intent === "SPRINT") {
        simplifiedJQL = safeJqlTemplates.CURRENT_SPRINT;
      } else {
        // Default fallback
        simplifiedJQL = `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY updated DESC`;
      }

      console.log("Using simplified JQL:", simplifiedJQL);

      // Try again with the simplified JQL
      jiraResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
        params: {
          jql: simplifiedJQL,
          maxResults: maxResults,
          fields,
        },
        auth,
      });

      // Add a note for the user (avoid showing error messages directly)
      if (jiraResponse.data && jiraResponse.data.issues) {
        conversationMemory[sessionId].note = "I've found some information that might help with your question:";
      }
    }

    // Step 5: Generate an intent-specific response
    const response = jiraResponse; // This is the result of either the original or fallback query

    let formattedResponse;

    // Include a note about the query simplification if it happened
    if (conversationMemory[sessionId].note) {
      const note = conversationMemory[sessionId].note;
      delete conversationMemory[sessionId].note; // Clear the note

      try {
        // Add the note to the beginning of the response
        const baseResponse = await generateResponse(query, response.data, intent, {
          previousQueries: conversationMemory[sessionId].queries,
        });

        formattedResponse = `${note}\n\n${baseResponse}`;
      } catch (responseError) {
        // If AI response generation fails, use a direct fallback
        const issues = response.data.issues;
        formattedResponse = `${note}\n\n`;

        if (issues.length === 0) {
          formattedResponse += "I couldn't find any issues matching your criteria.";
        } else {
          formattedResponse += `Here are ${Math.min(5, issues.length)} recent items:\n\n`;

          for (let i = 0; i < Math.min(5, issues.length); i++) {
            const issue = issues[i];
            const status = issue.fields.status?.name || "Unknown";
            const assignee = issue.fields.assignee?.displayName || "Unassigned";
            formattedResponse += `• ${issue.key}: ${issue.fields.summary} (${status}, Assigned to: ${assignee})\n`;
          }

          if (issues.length > 5) {
            formattedResponse += `\n... and ${issues.length - 5} more items.`;
          }
        }
      }
    } else {
      try {
        formattedResponse = await generateResponse(query, response.data, intent, {
          previousQueries: conversationMemory[sessionId].queries,
        });
      } catch (responseError) {
        console.error("Error generating AI response:", responseError);

        // Use an intent-based fallback response
        const issues = response.data.issues;
        if (issues.length === 0) {
          formattedResponse = "I couldn't find any issues matching your criteria. Would you like to try a different search?";
        } else {
          // Create a conversational opening
          const openings = [
            `I found ${issues.length} items related to your query.`,
            `Here's what I found about your question:`,
            `I've located ${issues.length} relevant issues:`,
            `Here's some information that might help:`,
          ];

          formattedResponse = openings[Math.floor(Math.random() * openings.length)] + "\n\n";

          // Group issues by a relevant field based on intent
          if (intent === "ASSIGNED_TASKS" || intent === "WORKLOAD") {
            // Group by assignee
            const byAssignee = {};
            issues.forEach((issue) => {
              const assignee = issue.fields.assignee?.displayName || "Unassigned";
              if (!byAssignee[assignee]) byAssignee[assignee] = [];
              byAssignee[assignee].push(issue);
            });

            for (const [assignee, assignedIssues] of Object.entries(byAssignee)) {
              formattedResponse += `**${assignee}** (${assignedIssues.length} issues):\n`;

              for (let i = 0; i < Math.min(3, assignedIssues.length); i++) {
                const issue = assignedIssues[i];
                const status = issue.fields.status?.name || "Unknown";
                formattedResponse += `• ${issue.key}: ${issue.fields.summary} (${status})\n`;
              }

              if (assignedIssues.length > 3) {
                formattedResponse += `... and ${assignedIssues.length - 3} more.\n`;
              }

              formattedResponse += "\n";
            }
          } else {
            // For other intents, group by status
            const byStatus = {};
            issues.forEach((issue) => {
              const status = issue.fields.status?.name || "Unknown";
              if (!byStatus[status]) byStatus[status] = [];
              byStatus[status].push(issue);
            });

            for (const [status, statusIssues] of Object.entries(byStatus)) {
              formattedResponse += `**${status}** (${statusIssues.length} issues):\n`;

              for (let i = 0; i < Math.min(3, statusIssues.length); i++) {
                const issue = statusIssues[i];
                const assignee = issue.fields.assignee?.displayName || "Unassigned";
                formattedResponse += `• ${issue.key}: ${issue.fields.summary} (Assigned to: ${assignee})\n`;
              }

              if (statusIssues.length > 3) {
                formattedResponse += `... and ${statusIssues.length - 3} more.\n`;
              }

              formattedResponse += "\n";
            }
          }
        }
      }
    }

    // Store the response in conversation memory
    conversationMemory[sessionId].lastResponse = formattedResponse;

    // Send the response back to the frontend
    return res.json({
      message: formattedResponse,
      rawData: response.data,
      meta: {
        intent,
        jql,
      },
    });
  } catch (error) {
    console.error("Error processing query:", error);

    // We never want to show raw error messages to the user
    // Instead, create a friendly, helpful response that doesn't reveal technical issues

    try {
      // Try a super-basic query to at least return something useful
      const basicResponse = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
        params: {
          jql: `project = ${process.env.JIRA_PROJECT_KEY} ORDER BY updated DESC`,
          maxResults: 5,
          fields: "summary,status,assignee",
        },
        auth,
      });

      if (basicResponse.data && basicResponse.data.issues && basicResponse.data.issues.length > 0) {
        const relevantInfo = [
          "I couldn't find exactly what you were looking for, but here are some recent items that might be helpful:",
          "Let me show you some recent activity in the project that might be relevant:",
          "While I couldn't answer your specific question, here are some recent updates in the project:",
          "I found some recent project activity that might interest you:",
        ];

        let message = relevantInfo[Math.floor(Math.random() * relevantInfo.length)] + "\n\n";

        basicResponse.data.issues.forEach((issue) => {
          const status = issue.fields.status?.name || "Unknown";
          const assignee = issue.fields.assignee?.displayName || "Unassigned";
          message += `• ${issue.key}: ${issue.fields.summary} (${status}, Assigned to: ${assignee})\n`;
        });

        message += "\n\nCould you try rephrasing your question? I can help you with project status, tasks, deadlines, and team workload.";

        return res.json({
          message: message,
          meta: { intent: "GENERAL" },
        });
      }
    } catch (fallbackError) {
      // Even the fallback failed, use a very generic response
    }

    // If all else fails, use these conversational error messages that don't seem like errors
    const friendlyResponses = [
      "I'm focusing on active issues in the project right now. Would you like to see recent updates or high priority items?",
      "I'd be happy to help you explore the project data. Could you ask me about project status, tasks, deadlines, or team workload?",
      "Let me help you navigate your Jira project. You can ask me about project status, tasks, deadlines, team assignments, and more.",
      "I'm here to help you with your Jira project information. What would you like to know about your tasks or project status?",
    ];

    return res.json({
      message: friendlyResponses[Math.floor(Math.random() * friendlyResponses.length)],
      meta: { intent: "GENERAL" },
    });
  }
});

// Improved project summary endpoint with more valuable information
app.get("/api/project-summary", async (req, res) => {
  try {
    // Run multiple queries in parallel for better performance
    const [openResponse, recentResponse, priorityResponse, unassignedResponse] = await Promise.all([
      // Get open issues count
      axios.get(`${JIRA_URL}/rest/api/3/search`, {
        params: {
          jql: `project = ${process.env.JIRA_PROJECT_KEY} AND status in ("Open", "In Progress", "To Do", "Reopened")`,
          maxResults: 0,
        },
        auth,
      }),

      // Get recently updated issues
      axios.get(`${JIRA_URL}/rest/api/3/search`, {
        params: {
          jql: `project = ${process.env.JIRA_PROJECT_KEY} AND updated >= -7d ORDER BY updated DESC`,
          maxResults: 5,
          fields: "summary,status,assignee,updated",
        },
        auth,
      }),

      // Get high priority issues
      axios.get(`${JIRA_URL}/rest/api/3/search`, {
        params: {
          jql: `project = ${process.env.JIRA_PROJECT_KEY} AND priority in ("High", "Highest") AND status != "Done"`,
          maxResults: 5,
          fields: "summary,status,assignee,priority",
        },
        auth,
      }),

      // Get unassigned issues
      axios.get(`${JIRA_URL}/rest/api/3/search`, {
        params: {
          jql: `project = ${process.env.JIRA_PROJECT_KEY} AND assignee is EMPTY AND status != "Done"`,
          maxResults: 5,
          fields: "summary,status,priority,created",
        },
        auth,
      }),
    ]);

    // Put it all together in a rich project summary
    res.json({
      openCount: openResponse.data.total,
      recentIssues: recentResponse.data.issues,
      highPriorityIssues: priorityResponse.data.issues,
      unassignedIssues: unassignedResponse.data.issues,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching project summary:", error);
    res.status(500).json({
      message: "Couldn't retrieve the project summary at this time. Please try again later.",
    });
  }
});

// New endpoint to clear conversation context if needed
app.post("/api/reset-conversation", (req, res) => {
  const { sessionId = "default" } = req.body;

  if (conversationMemory[sessionId]) {
    conversationMemory[sessionId] = {
      queries: [],
      intents: [],
      lastResponse: null,
    };
  }

  res.json({ success: true, message: "Conversation reset successfully" });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
