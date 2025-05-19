import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from 'cloudflare:workers';

export interface Env {
  AI: Ai;
  GOOGLE_CLIENT_EMAIL: string; // service account email
  GOOGLE_PRIVATE_KEY: string; // https://console.cloud.google.com/iam-admin/serviceaccounts -> service account -> keys -> add key -> create new key -> JSON -> get private key from JSON
  GOOGLE_CALENDAR_ID: string; //email of calendar to query ie lizzie.siegle@gmail.com
}

function getEnv<Env>() {
	return env as Env;
}


export class MyMCP extends McpAgent {
	server = new McpServer({
        name: "Google Calendar Query",
        version: "2.0.0",
    });

	toDayString(date: Date) {
		switch (date.getDay()) {
			case 0:
				return "Sunday";
			case 1:
				return "Monday";
			case 2:
				return "Tuesday";
			case 3:
				return "Wednesday";
			case 4:
				return "Thursday";
			case 5:
				return "Friday";
			case 6:
				return "Saturday";
			default:
				return "Unknown";
		}
	}

	async init() {
		this.server.tool(
            "query_google_calendar",
            "Query Google Calendar events and shape data",
            {
                query: z.string().describe("Search query for calendar events on a certain date")
            },
            async ({ query }) => {
                try {
                    const env = getEnv<Env>();

                    // First LLM call to determine date range
                    const dateRangePrompt = `Given the query "${query}", todays date is ${new Date().toISOString()}, and it is a ${this.toDayString(new Date())} determine the start and end dates to search for calendar events. 
                    Return ONLY a JSON object with two ISO date strings: startDate and endDate.
                    Example: {"startDate": "2024-03-15T00:00:00Z", "endDate": "2024-03-17T23:59:59Z"}
                    Today's date is ${new Date().toISOString()} and with dates at the start and end of a day pacific
					DO NOT INCLUDE ANY OTHER TEXT BESIDES VALID JSON`;

                    const dateRangeMessages = [
                        { role: "system", content: "You are a helpful assistant that determines date ranges for calendar queries. Return only valid JSON with ISO date strings." },
                        { role: "user", content: dateRangePrompt }
                    ];

                    const dateRangeResponse = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages: dateRangeMessages });
                    console.log("Date range response:", dateRangeResponse);
                    
                    // Extract the JSON string from the response
                    const jsonMatch = JSON.parse(dateRangeResponse.response.toString());
					console.log("JSON match:", jsonMatch);
                    if (!jsonMatch) {
                        throw new Error("Could not parse date range from LLM response");
                    }
                    const dateRange = {
                        startDate: new Date(new Date(jsonMatch.startDate).getTime()), // PST from UTC 
                        endDate: new Date(new Date(jsonMatch.endDate).getTime()) // PST from UTC
                    }
                    console.log("date match:", dateRange);
					

                    const { GoogleAuth } = await import('google-auth-library');
                    const { google } = await import('googleapis');

                    let privateKey = env.GOOGLE_PRIVATE_KEY;
                    if (privateKey.includes('\\n')) {
                        privateKey = privateKey.replace(/\\n/g, '\n');
                    }
                    if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
                        privateKey = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
                    }

                    const auth = new GoogleAuth({
                        credentials: {
                            client_email: env.GOOGLE_CLIENT_EMAIL,
                            private_key: privateKey
                        },
                        scopes: ['https://www.googleapis.com/auth/calendar'],
                    });

                    const calendar = google.calendar({ version: 'v3', auth });

                    // Step 1: Subscribe to new shared calendars
                    const newEmails = [env.GOOGLE_CALENDAR_ID];
                    for (const email of newEmails) {
                        await calendar.calendarList.insert({ requestBody: { id: email } });
                        console.log(`Subscribed to calendar: ${email}`);
                    }

                    // Step 2: List all subscribed calendars
                    const calendarsResult = await calendar.calendarList.list();
                    const calendars = calendarsResult.data.items || [];
                    const emails = calendars.map(c => c.id);
                    console.log(`Total subscribed calendars: ${emails.length}`);

                    if (!emails.length) {
                        throw new Error("No accessible calendars found");
                    }

                    console.log(`Querying events from ${dateRange.startDate} to ${dateRange.endDate}`);

                    const response = await calendar.events.list({
                        calendarId: emails[0] || 'primary',
                        timeMin: dateRange.startDate.toISOString(),
                        timeMax: dateRange.endDate.toISOString(),
                        maxResults: 50,
                        singleEvents: true,
                        orderBy: 'startTime',
                    } as const);

                    const df = (response.data.items || []).map(item => {
                        const start = item.start?.dateTime || item.start?.date;
                        const end = item.end?.dateTime || item.end?.date;

                        // Convert UTC to PST (UTC-7)
                        const startDate = start ? new Date(start) : null;
                        const endDate = end ? new Date(end) : null;

                        // Format the dates in PST
                        const formatDate = (date: Date) => {
                            return date.toLocaleString('en-US', {
                                timeZone: 'America/Los_Angeles',
                                year: 'numeric',
                                month: 'numeric',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: 'numeric',
                                hour12: true
                            });
                        };

                        return {
                            name: item.summary || 'No title',
                            creator: item.creator?.email || '',
                            start: startDate ? formatDate(startDate) : '',
                            end: endDate ? formatDate(endDate) : '',
                            attendees: item.attendees || [],
                            location: item.location || '',
                            queried_from: emails[0],
                            id: item.id,
                            timeZone: 'America/Los_Angeles',
                            duration: startDate && endDate ? 
                                Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60)) + ' mins' : ''
                        };
                    });

                    // Build context for LLM
                    const eventsContext = df.map(event => `
                        Event: ${event.name}
                        Time: ${event.start} - ${event.end}
                        Location: ${event.location || 'No location specified'}
                        Duration: ${event.duration}
                        Attendees: ${event.attendees.length > 0 ? event.attendees.map(a => a.email).join(', ') : 'No attendees'}
                    `).join('\n');

                    // Second LLM call to summarize events
                    const summaryPrompt = `I searched the calendar for "${query}" and found these events between ${new Date(dateRange.startDate).toLocaleDateString()} and ${new Date(dateRange.endDate).toLocaleDateString()}:
					${eventsContext}

					Please provide a natural language summary of these events. Focus on:
					1. The most important or upcoming events prioritizing the time period of the query
					2. Any patterns or clusters of events
					3. Highlight any events with specific locations or many attendees
					4. Mention the total number of events found
					5. Do not mention events unless relevant to the query
					6. Today's date is ${new Date().toDateString()}

					Format the response in a friendly, conversational way. Keep the response concise and under 200 words.`;

                    const summaryMessages = [
                        { role: "system", content: "You are a helpful calendar assistant that provides clear, concise summaries of calendar events. Focus on making the information easily digestible and highlighting the most relevant details. Keep responses brief and under 100 words." },
                        { role: "user", content: summaryPrompt }
                    ];

                    try {
                        const llmResponse = await Promise.race([
                            env.AI.run("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", { messages: summaryMessages }),
                            new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('AI response timeout')), 10000)
                            )
                        ]);

                        // Extract the text response from the LLM output
                        const responseText = typeof llmResponse === 'string' ? 
                            llmResponse : 
                            (llmResponse.response?.toString() || JSON.stringify(llmResponse));

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: responseText
                                }
                            ]
                        };
                    } catch (error) {
                        console.error("Error calling AI model:", error);
                        // Fallback to basic response if AI fails
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Found ${df.length} events between ${new Date(dateRange.startDate).toLocaleDateString()} and ${new Date(dateRange.endDate).toLocaleDateString()}:\n${eventsContext}`
                                }
                            ]
                        };
                    }

                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return {
                        content: [{ type: "text" as const, text: `❌ Error querying calendar: ${errorMessage}` }]
                    };
                }
            }
        );

		this.server.tool(
            "create_calendar_event",
            "Create a new calendar event",
            {
                name: z.string().describe("Name/title of the event"),
                date: z.string().describe("Date of the event in YYYY-MM-DD format"),
                time: z.string().describe("Time of the event in HH:MM format (24-hour)"),
                location: z.string().optional().describe("Location of the event (optional)")
            },
            async ({ name, date, time, location }) => {
                try {
                    const env = getEnv<Env>();

                    // First LLM call to parse and validate time
                    const timePrompt = `Convert the time "${time}" to 24-hour format (HH:MM).
                    IMPORTANT: Return ONLY a JSON object with a single field "time" in HH:MM format.
                    Example: {"time": "14:30"}
                    DO NOT include any explanation or thinking process.
                    DO NOT include any other text besides the JSON object.`;

                    const timeMessages = [
                        { role: "system", content: "You are a time format converter. Return ONLY valid JSON with time in HH:MM format and nothing else or else you will be fired and fined a lot of money. No explanations or other text." },
                        { role: "user", content: timePrompt }
                    ];

                    const timeResponse = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages: timeMessages });
                    console.log("Raw time response:", timeResponse);
                    
                    let timeMatch;
                    try {
                        const responseText = typeof timeResponse === 'string' ? timeResponse : timeResponse.response;
                        console.log("Response text:", responseText);
                        // Extract JSON from the response if it contains other text
                        const jsonMatch = responseText.match(/\{.*\}/);
                        if (!jsonMatch) {
                            throw new Error("No JSON found in response");
                        }
                        timeMatch = JSON.parse(jsonMatch[0]);
                        console.log("Time match:", timeMatch);
                    } catch (e) {
                        console.error("Error handling time response:", e);
                        throw new Error("Failed to process time response");
                    }

                    if (!timeMatch || !timeMatch.time) {
                        throw new Error("Invalid time format in response");
                    }

				const { GoogleAuth } = await import('google-auth-library');
				const { google } = await import('googleapis');
		  
                    let privateKey = env.GOOGLE_PRIVATE_KEY;
                    if (privateKey.includes('\\n')) {
                        privateKey = privateKey.replace(/\\n/g, '\n');
                    }
                    if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
                        privateKey = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
                    }

				const auth = new GoogleAuth({
                        credentials: {
                            client_email: env.GOOGLE_CLIENT_EMAIL,
                            private_key: privateKey
                        },
                        scopes: ['https://www.googleapis.com/auth/calendar'],
				});
		  
				const calendar = google.calendar({ version: 'v3', auth });
		  
                    // Parse date and time
                    const [year, month, day] = date.split('-').map(Number);
                    const [hours, minutes] = timeMatch.time.split(':').map(Number);
                    
                    // Create start and end times (default to 1 hour duration)
                    const startTime = new Date(year, month - 1, day, hours, minutes);
                    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // Add 1 hour

                    // Create the event
                    const event = {
                        summary: name,
                        start: {
                            dateTime: startTime.toISOString(),
                            timeZone: 'America/Los_Angeles',
                        },
                        end: {
                            dateTime: endTime.toISOString(),
                            timeZone: 'America/Los_Angeles',
                        },
                        ...(location && { location }),
                    };

                    const response = await calendar.events.insert({
                        calendarId: env.GOOGLE_CALENDAR_ID,
                        requestBody: event,
                    });

				  return {
                        content: [
                            {
                                type: "text",
                                text: `✅ Created event "${name}" on ${date} at ${time}${location ? ` at ${location}` : ''}`
                            }
                        ]
                    };

			  } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
				return {
                        content: [{ type: "text" as const, text: `❌ Error creating calendar event: ${errorMessage}` }]
				};
			  }
			}
		);
        this.server.tool(
            "remove_calendar_event",
            "Remove a calendar event by event name/summary and optional date. Deletes the first match.",
            {
                query: z.string().describe("Event name or summary to search for (required)"),
                date: z.string().optional().describe("Date of the event in YYYY-MM-DD format (optional)")
            },
            async ({ query, date }) => {
                try {
                    const env = getEnv<Env>();
                    const { GoogleAuth } = await import('google-auth-library');
                    const { google } = await import('googleapis');

                    let privateKey = env.GOOGLE_PRIVATE_KEY;
                    if (privateKey.includes('\\n')) {
                        privateKey = privateKey.replace(/\\n/g, '\n');
                    }
                    if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
                        privateKey = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
                    }

                    const auth = new GoogleAuth({
                        credentials: {
                            client_email: env.GOOGLE_CLIENT_EMAIL,
                            private_key: privateKey
                        },
                        scopes: ['https://www.googleapis.com/auth/calendar'],
                    });

                    const calendar = google.calendar({ version: 'v3', auth });

                    // Calculate timeMin/timeMax
                    let timeMin, timeMax;
                    if (date) {
                        // If a date is provided, search only that day in America/Los_Angeles
                        const tz = 'America/Los_Angeles';
                        const d = new Date(`${date}T00:00:00-07:00`); // -07:00 for PDT
                        timeMin = new Date(d).toISOString();
                        const endOfDay = new Date(d);
                        endOfDay.setHours(23, 59, 59, 999);
                        timeMax = endOfDay.toISOString();
                    } else {
                        // Default: search from start of this week to end of next week in America/Los_Angeles
                        const now = new Date();
                        const tz = 'America/Los_Angeles';
                        // Get start of this week (Sunday)
                        const startOfWeek = new Date(now);
                        startOfWeek.setDate(now.getDate() - now.getDay());
                        startOfWeek.setHours(0, 0, 0, 0);
                        // Get end of next week (Saturday)
                        const endOfNextWeek = new Date(startOfWeek);
                        endOfNextWeek.setDate(startOfWeek.getDate() + 13); // 7 days this week + 6 days next week
                        endOfNextWeek.setHours(23, 59, 59, 999);
                        timeMin = startOfWeek.toISOString();
                        timeMax = endOfNextWeek.toISOString();
                    }

                    // List events (limit to 100 for performance)
                    const listParams = {
                        calendarId: env.GOOGLE_CALENDAR_ID,
                        maxResults: 100,
                        singleEvents: true,
                        orderBy: 'startTime',
                        timeMin,
                        timeMax
                    };
                    console.log("List params:", listParams);
                    const response = await calendar.events.list(listParams);
                    const items = response.data.items || [];
                    console.log("Items:", items);

                    // Find the first event whose summary matches the query (case-insensitive, partial)
                    const match = items.find(e =>
                        e.summary && e.summary.toLowerCase().includes(query.toLowerCase())
                    );
                    console.log("Match:", match);

                    if (!match) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `❌ No event found matching \"${query}\"${date ? ` on ${date}` : ''}`
                                }
                            ]
                        };
                    }

                    await calendar.events.delete({
                        calendarId: env.GOOGLE_CALENDAR_ID,
                        eventId: match.id!,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `✅ Deleted event: \"${match.summary}\"${match.start?.dateTime ? ` at ${match.start.dateTime}` : ''}`
                            }
                        ]
                    };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return {
                        content: [{ type: "text" as const, text: `❌ Error removing calendar event: ${errorMessage}` }]
                    };
                }
            }
        );
        this.server.tool(
            "update_calendar_event",
            "Update an existing calendar event by event name/summary and optional date. You can change the title, date, time, or location. Only updates provided fields.",
            {
                query: z.string().describe("Event name or summary to search for (required)"),
                date: z.string().optional().describe("Date of the event in YYYY-MM-DD format (optional)"),
                newTitle: z.string().optional().describe("New title for the event (optional)"),
                newDate: z.string().optional().describe("New date in YYYY-MM-DD format (optional)"),
                newTime: z.string().optional().describe("New time in HH:MM format (24-hour, optional)"),
                newLocation: z.string().optional().describe("New location for the event (optional)")
            },
            async ({ query, date, newTitle, newDate, newTime, newLocation }) => {
                try {
                    const env = getEnv<Env>();
                    const { GoogleAuth } = await import('google-auth-library');
                    const { google } = await import('googleapis');

                    let privateKey = env.GOOGLE_PRIVATE_KEY;
                    if (privateKey.includes('\\n')) {
                        privateKey = privateKey.replace(/\\n/g, '\n');
                    }
                    if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
                        privateKey = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
                    }

                    const auth = new GoogleAuth({
                        credentials: {
                            client_email: env.GOOGLE_CLIENT_EMAIL,
                            private_key: privateKey
                        },
                        scopes: ['https://www.googleapis.com/auth/calendar'],
                    });

                    const calendar = google.calendar({ version: 'v3', auth });

                    // Calculate timeMin/timeMax
                    let timeMin, timeMax;
                    if (date) {
                        const d = new Date(`${date}T00:00:00-07:00`); // PDT
                        timeMin = new Date(d).toISOString();
                        const endOfDay = new Date(d);
                        endOfDay.setHours(23, 59, 59, 999);
                        timeMax = endOfDay.toISOString();
                    } else {
                        const now = new Date();
                        const startOfWeek = new Date(now);
                        startOfWeek.setDate(now.getDate() - now.getDay());
                        startOfWeek.setHours(0, 0, 0, 0);
                        const endOfNextWeek = new Date(startOfWeek);
                        endOfNextWeek.setDate(startOfWeek.getDate() + 13);
                        endOfNextWeek.setHours(23, 59, 59, 999);
                        timeMin = startOfWeek.toISOString();
                        timeMax = endOfNextWeek.toISOString();
                    }

                    // List events (limit to 100 for performance)
                    const listParams = {
                        calendarId: env.GOOGLE_CALENDAR_ID,
                        maxResults: 100,
                        singleEvents: true,
                        orderBy: 'startTime',
                        timeMin,
                        timeMax
                    };
                    const response = await calendar.events.list(listParams);
                    const items = response.data.items || [];

                    // Find the first event whose summary matches the query (case-insensitive, partial)
                    const match = items.find(e =>
                        e.summary && e.summary.toLowerCase().includes(query.toLowerCase())
                    );

                    if (!match) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `❌ No event found matching \"${query}\"${date ? ` on ${date}` : ''}`
                                }
                            ]
                        };
                    }

                    // Prepare updated fields
                    const updatedEvent: any = {};
                    if (newTitle) updatedEvent.summary = newTitle;
                    let startDateTime = match.start?.dateTime || match.start?.date;
                    let endDateTime = match.end?.dateTime || match.end?.date;
                    let timeZone = match.start?.timeZone || 'America/Los_Angeles';

                    // If new date or time, update start/end
                    if (newDate || newTime) {
                        // Use existing date/time if not provided
                        let dateStr = newDate ? newDate : (typeof startDateTime === 'string' ? startDateTime.substring(0,10) : '1970-01-01');
                        let [year, month, day] = dateStr.split('-').map(Number);
                        let [hours, minutes] = [0, 0];
                        if (newTime) {
                            [hours, minutes] = newTime.split(':').map(Number);
                        } else if (typeof startDateTime === 'string' && startDateTime.length > 10) {
                            // If original event has time
                            const d = new Date(startDateTime);
                            hours = d.getHours();
                            minutes = d.getMinutes();
                        }
                        const start = new Date(year, month - 1, day, hours, minutes);
                        const end = new Date(start.getTime() + 60 * 60 * 1000); // Default 1 hour duration
                        updatedEvent.start = { dateTime: start.toISOString(), timeZone };
                        updatedEvent.end = { dateTime: end.toISOString(), timeZone };
                    }
                    if (newLocation) updatedEvent.location = newLocation;

                    // Update the event
                    await calendar.events.patch({
                        calendarId: env.GOOGLE_CALENDAR_ID,
                        eventId: match.id!,
                        requestBody: updatedEvent
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `✅ Updated event: \"${match.summary}\"${newTitle ? ` to \"${newTitle}\"` : ''}${newDate || newTime ? ` with new date/time` : ''}${newLocation ? ` at ${newLocation}` : ''}`
                            }
                        ]
                    };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return {
                        content: [{ type: "text" as const, text: `❌ Error updating calendar event: ${errorMessage}` }]
                    };
                }
            }
        );
	}
  }

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// @ts-ignore
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			// @ts-ignore
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
