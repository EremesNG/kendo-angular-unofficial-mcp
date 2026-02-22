#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import TurndownService from "turndown";

const BASE_URL = "https://www.telerik.com/kendo-angular-ui/components";

// Initialize Turndown to convert HTML to Markdown
const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
});

// Basic in-memory cache system to avoid overloading Telerik servers
const cache = new Map<string, { data: string; timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

async function fetchHtml(url: string): Promise<string> {
    const cached = cache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.error(`[Cache Hit] Fetching: ${url}`);
        return cached.data;
    }
    
    console.error(`[Network] Fetching: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} when trying to access ${url}`);
    }
    const html = await response.text();
    cache.set(url, { data: html, timestamp: Date.now() });
    return html;
}

// 1. Initialize the MCP server using the high-level API
const server = new McpServer({
    name: "kendo-angular-unofficial-mcp",
    version: "1.0.0",
});

// 2. Register tools declaratively
server.tool(
    "list_kendo_components",
    "Retrieves a list of all main Kendo UI for Angular components available in the documentation.",
    {},
    async () => {
        try {
            const html = await fetchHtml(`${BASE_URL}/`);
            const $ = cheerio.load(html);
            const components: string[] = [];
            
            // Regex to capture 1st level component paths
            // e.g., /kendo-angular-ui/components/grid/ or /kendo-angular-ui/components/buttons
            $("a").each((_, el) => {
                const href = $(el).attr("href");
                if (!href) return;
                
                const match = href.match(/^\/kendo-angular-ui\/components\/([a-zA-Z0-9-]+)\/?$/);
                if (match) {
                    const path = match[1];
                    // Keep only the raw semantic path
                    if (path && !components.includes(path)) {
                        components.push(path);
                    }
                }
            });
            
            return {
                content: [
                    {
                        type: "text",
                        text: components.length > 0
                            ? components.join('\n')
                            : "Could not extract components. Check Cheerio CSS selectors.",
                    },
                ],
            };
        } catch (error: any) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

server.tool(
    "list_component_topics",
    "Given a component ID (e.g., 'grid'), returns a list of subtopics and articles available for that component. Note: For deep API references (components, directives, classes), use the 'list_component_api' tool instead.",
    {
        componentId: z.string().describe("The component identifier in the URL (e.g., 'grid', 'buttons', 'dropdowns').")
    },
    async ({ componentId }) => {
        try {
            const cleanId = componentId.replace(/^\//, ""); // Remove initial slash if exists
            const topics: string[] = [];
            const prefix = `/kendo-angular-ui/components/${cleanId}/`;
            
            try {
                // Strategy 1: Fetch the sitemap.xml to get ALL pages.
                const sitemapUrl = `${BASE_URL}/sitemap.xml`;
                const sitemapXml = await fetchHtml(sitemapUrl);
                
                const locRegex = /<loc>(.*?)<\/loc>/g;
                let match;
                
                while ((match = locRegex.exec(sitemapXml)) !== null) {
                    const url = match[1];
                    // Verify it belongs to the component and is not the root component page itself
                    if (url.includes(prefix) && !url.endsWith(`${cleanId}`) && !url.endsWith(`${cleanId}/`)) {
                        const relativePath = url.split("/kendo-angular-ui/components/")[1]?.replace(/\/$/, "");
                        
                        // Exclude deep API reference pages to avoid token bloat.
                        if (relativePath && relativePath.includes('/api/') && relativePath !== `${cleanId}/api`) {
                            continue;
                        }
                        
                        // Strip the redundant component prefix to save tokens (e.g., "grid/rows/sticky" -> "rows/sticky")
                        const shortPath = relativePath.startsWith(`${cleanId}/`)
                            ? relativePath.substring(cleanId.length + 1)
                            : relativePath;
                        
                        if (shortPath && !topics.includes(shortPath) && shortPath !== cleanId) {
                            topics.push(shortPath);
                        }
                    }
                }
            } catch (sitemapError) {
                console.error("Sitemap strategy failed, falling back to HTML scraping...", sitemapError);
            }
            
            // Strategy 2: Fallback to HTML DOM scraping if sitemap fails
            if (topics.length === 0) {
                const html = await fetchHtml(`${BASE_URL}/${cleanId}`);
                const $ = cheerio.load(html);
                
                $("a").each((_, el) => {
                    const href = $(el).attr("href");
                    
                    if (href && href.startsWith(prefix) && href !== prefix && !href.includes("#")) {
                        const relativePath = href.replace("/kendo-angular-ui/components/", "").replace(/\/$/, "");
                        
                        if (relativePath && relativePath.includes('/api/') && relativePath !== `${cleanId}/api`) {
                            return;
                        }
                        
                        const shortPath = relativePath.startsWith(`${cleanId}/`)
                            ? relativePath.substring(cleanId.length + 1)
                            : relativePath;
                        
                        if (shortPath && !topics.includes(shortPath) && shortPath !== cleanId) {
                            topics.push(shortPath);
                        }
                    }
                });
            }
            
            if (topics.length === 0) {
                return { content: [{ type: "text", text: `No subtopics found for component: ${cleanId}` }] };
            }
            
            // --- TOKEN OPTIMIZATION: Group by subfolder ---
            const grouped: Record<string, string[]> = {};
            const rootLevel: string[] = [];
            
            topics.forEach(t => {
                const parts = t.split('/');
                if (parts.length === 1) {
                    rootLevel.push(t);
                } else {
                    const folder = parts[0];
                    const rest = parts.slice(1).join('/');
                    if (!grouped[folder]) grouped[folder] = [];
                    grouped[folder].push(rest);
                }
            });
            
            let optimizedText = `[Prefix with /${cleanId}/ for read_kendo_doc]\n`;
            if (rootLevel.length > 0) {
                optimizedText += rootLevel.join(', ') + '\n';
            }
            for (const [folder, items] of Object.entries(grouped)) {
                optimizedText += `${folder}/: ${items.join(', ')}\n`;
            }
            
            return {
                content: [
                    {
                        type: "text",
                        text: optimizedText,
                    },
                ],
            };
        } catch (error: any) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

// --- NUEVA HERRAMIENTA PARA LA API ---
server.tool(
    "list_component_api",
    "Given a component ID (e.g., 'grid'), returns a list of detailed API references (components, directives, interfaces, services) available for that component.",
    {
        componentId: z.string().describe("The component identifier in the URL (e.g., 'grid').")
    },
    async ({ componentId }) => {
        try {
            const cleanId = componentId.replace(/^\//, "");
            const apiTopics: string[] = [];
            const prefix = `/kendo-angular-ui/components/${cleanId}/api/`;
            
            try {
                // Strategy 1: Fetch the sitemap.xml
                const sitemapUrl = `${BASE_URL}/sitemap.xml`;
                const sitemapXml = await fetchHtml(sitemapUrl);
                
                const locRegex = /<loc>(.*?)<\/loc>/g;
                let match;
                
                while ((match = locRegex.exec(sitemapXml)) !== null) {
                    const url = match[1];
                    // We strictly look for deep API links, ignoring the root API page itself
                    if (url.includes(prefix) && !url.endsWith(`${cleanId}/api`) && !url.endsWith(`${cleanId}/api/`)) {
                        const apiSlug = url.split(prefix)[1]?.replace(/\/$/, "");
                        
                        if (apiSlug && !apiTopics.includes(apiSlug)) {
                            apiTopics.push(apiSlug);
                        }
                    }
                }
            } catch (sitemapError) {
                console.error("Sitemap strategy failed, falling back to HTML scraping...", sitemapError);
            }
            
            // Strategy 2: Fallback to HTML DOM scraping of the /api/ page
            if (apiTopics.length === 0) {
                const html = await fetchHtml(`${BASE_URL}/${cleanId}/api`);
                const $ = cheerio.load(html);
                
                $("a").each((_, el) => {
                    const href = $(el).attr("href");
                    
                    if (href && href.includes(prefix) && !href.endsWith(`${cleanId}/api`) && !href.endsWith(`${cleanId}/api/`) && !href.includes("#")) {
                        const apiSlug = href.split(prefix)[1]?.replace(/\/$/, "");
                        
                        if (apiSlug && !apiTopics.includes(apiSlug)) {
                            apiTopics.push(apiSlug);
                        }
                    }
                });
            }
            
            if (apiTopics.length === 0) {
                return { content: [{ type: "text", text: `No detailed API references found for component: ${cleanId}` }] };
            }
            
            // --- TOKEN OPTIMIZATION PARA LA API ---
            // Como todos pertenecen a la misma carpeta (/api/), una simple lista separada por comas es lo más eficiente.
            const optimizedText = `[Prefix with /${cleanId}/api/ for read_kendo_doc]\n${apiTopics.join(', ')}`;
            
            return {
                content: [
                    {
                        type: "text",
                        text: optimizedText,
                    },
                ],
            };
        } catch (error: any) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

server.tool(
    "read_kendo_doc",
    "Reads a specific Kendo UI documentation article and returns it in Markdown format. Useful for reading code examples and APIs.",
    {
        path: z.string().describe("The relative path of the article (e.g., '/grid/data-binding/basics'). Remember to include the component prefix if you extracted it from a grouped list.")
    },
    async ({ path }) => {
        try {
            const cleanPath = path.startsWith("/") ? path : `/${path}`;
            const targetUrl = `${BASE_URL}${cleanPath}`;
            
            const html = await fetchHtml(targetUrl);
            const $ = cheerio.load(html);
            
            // Exhaustive DOM cleaning to avoid sending "garbage" to the LLM
            // Remove left sidebar, right table of contents (TOC), scripts, styles, and widgets
            $("nav, header, footer, aside, .kd-sidebar, .page-toc, #TableOfContents, .toc-container, .feedback-panel, .edit-page, script, style, noscript, svg").remove();
            
            // Search for the most common Gatsby/Telerik selectors for main content
            let articleHtml = $("article").html() || $("main").html() || $(".kd-article").html() || $(".markdown-section").html();
            
            if (!articleHtml) {
                // Generic fallback if no semantic container is found
                articleHtml = $("body").html();
            }
            
            if (!articleHtml) {
                return { content: [{ type: "text", text: "Error: Could not find the main content of the article." }], isError: true };
            }
            
            const markdown = turndownService.turndown(articleHtml);
            
            return {
                content: [
                    {
                        type: "text",
                        text: `# Documentation extracted from: ${targetUrl}\n\n${markdown}`,
                    },
                ],
            };
        } catch (error: any) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

// 3. Start the server with Stdio transport
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Kendo UI Unofficial MCP Server running via stdio.");
}

main().catch((error) => {
    console.error("Fatal error starting the MCP server:", error);
    process.exit(1);
});