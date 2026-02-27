#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import TurndownService from "turndown";

const BASE_URL = "https://www.telerik.com/kendo-angular-ui/components";
const DEMOS_BASE_URL = "https://demos.telerik.com/kendo-angular-ui/demos";
const PAGE_DATA_BASE_URL = `${BASE_URL}/page-data`;

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

function extractDemoMetaurls(node: any): string[] {
    const metaurls: string[] = [];
    function walk(n: any): void {
        if (n && n.tagName === "demo" && n.properties?.metaurl) {
            const url = n.properties.metaurl as string;
            if (!metaurls.includes(url)) {
                metaurls.push(url);
            }
        }
        if (n?.children && Array.isArray(n.children)) {
            for (const child of n.children) {
                walk(child);
            }
        }
    }
    walk(node);
    return metaurls;
}

// --- AST-to-HTML conversion for Gatsby page-data.json ---
const SKIP_TAGS = new Set(["ctapanelsmall", "gitcommithistory", "demo"]);
const PASSTHROUGH_TAGS = new Set([
    "codeblock", "row", "column",
    "componenttitle", "componentdescription", "span",
]);
const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function astToHtml(node: any): string {
    if (!node) return "";
    if (node.type === "text") return escapeHtml(node.value || "");
    if (node.type === "root") return (node.children || []).map((c: any) => astToHtml(c)).join("");
    if (node.type !== "element") return "";

    const tag = node.tagName as string;
    if (SKIP_TAGS.has(tag)) return "";

    const childrenHtml = (node.children || []).map((c: any) => astToHtml(c)).join("");
    if (PASSTHROUGH_TAGS.has(tag)) return childrenHtml;

    // Custom Gatsby tile component → render as link
    if (tag === "component") {
        const href = node.properties?.href;
        return href ? `<p><a href="${escapeHtml(href)}">${childrenHtml}</a></p>` : childrenHtml;
    }

    // Anchor links: strip in-page # refs (not useful for LLM consumption)
    if (tag === "a") {
        const href = node.properties?.href || "";
        if (typeof href === "string" && href.startsWith("#")) return childrenHtml;
        return `<a href="${escapeHtml(String(href))}">${childrenHtml}</a>`;
    }

    // Code: preserve language class for fenced code blocks
    if (tag === "code") {
        const classes = node.properties?.className;
        if (Array.isArray(classes)) {
            const langClass = classes.find((c: string) => typeof c === "string" && c.startsWith("language-"));
            if (langClass) return `<code class="${langClass}">${childrenHtml}</code>`;
        }
        return `<code>${childrenHtml}</code>`;
    }

    // Image: preserve src and alt
    if (tag === "img") {
        const src = node.properties?.src ? ` src="${escapeHtml(String(node.properties.src))}"` : "";
        const alt = node.properties?.alt ? ` alt="${escapeHtml(String(node.properties.alt))}"` : "";
        return `<img${src}${alt}>`;
    }

    if (VOID_TAGS.has(tag)) return `<${tag}>`;

    // All other standard HTML elements: render without attributes (cleaner for turndown)
    return `<${tag}>${childrenHtml}</${tag}>`;
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
    "Reads a specific Kendo UI documentation article and returns it in Markdown format. Includes a list of available demo examples at the end. Use read_demo_source to fetch demo source code.",
    {
        path: z.string().describe("The relative path of the article (e.g., '/grid/data-binding/basics'). Remember to include the component prefix if you extracted it from a grouped list.")
    },
    async ({ path }) => {
        try {
            const cleanPath = path.startsWith("/") ? path : `/${path}`;
            const targetUrl = `${BASE_URL}${cleanPath}`;

            let markdown = "";
            let demoSection = "";

            // Primary: Gatsby page-data.json (single fetch, clean AST, no HTML scraping)
            try {
                const pageDataUrl = `${PAGE_DATA_BASE_URL}${cleanPath}/page-data.json`;
                const pageDataRaw = await fetchHtml(pageDataUrl);
                const pageData = JSON.parse(pageDataRaw);
                const htmlAst = pageData?.result?.data?.markdownRemark?.htmlAst;

                if (htmlAst) {
                    const cleanHtml = astToHtml(htmlAst);
                    markdown = turndownService.turndown(cleanHtml);

                    // Extract demos from the same AST (no extra fetch needed)
                    const demoMetaurls = extractDemoMetaurls(htmlAst);
                    if (demoMetaurls.length > 0) {
                        demoSection = "\n\n## Demos [use read_demo_source tool with metaUrl]\n" +
                            demoMetaurls.map((url: string) => `- ${url}`).join('\n');
                    }
                }
            } catch {
                // page-data.json unavailable; fall through to HTML scraping
            }

            // Fallback: Traditional HTML scraping with cheerio
            if (!markdown) {
                const html = await fetchHtml(targetUrl);
                const $ = cheerio.load(html);

                $("nav, header, footer, aside, .kd-sidebar, .page-toc, #TableOfContents, .toc-container, .feedback-panel, .edit-page, script, style, noscript, svg").remove();

                let articleHtml = $("article").html() || $("main").html() || $(".kd-article").html() || $(".markdown-section").html();
                if (!articleHtml) articleHtml = $("body").html();

                if (!articleHtml) {
                    return { content: [{ type: "text", text: "Error: Could not find the main content of the article." }], isError: true };
                }

                markdown = turndownService.turndown(articleHtml);
            }

            return {
                content: [{
                    type: "text",
                    text: `# Documentation extracted from: ${targetUrl}\n\n${markdown}${demoSection}`,
                }],
            };
        } catch (error: any) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

server.tool(
    "read_demo_source",
    "Fetches the source code files for a specific Kendo UI demo example. Use the metaUrl values listed in the 'Demos' section of read_kendo_doc output.",
    {
        metaUrl: z.string().describe("The demo metaurl path (e.g., 'grid/data-operations/directive/filtering/'). Obtained from read_kendo_doc output.")
    },
    async ({ metaUrl }) => {
        try {
            const cleanUrl = metaUrl.replace(/^\//, '').replace(/\/$/, '');
            const demoJsonUrl = `${DEMOS_BASE_URL}/${cleanUrl}/demo.json`;

            const demoJsonRaw = await fetchHtml(demoJsonUrl);
            const demoData = JSON.parse(demoJsonRaw);

            const files = demoData?.source?.files;
            if (!files || files.length === 0) {
                return { content: [{ type: "text", text: "No source files found for this demo." }] };
            }

            // Fetch all source files in parallel
            const fileContents = await Promise.all(
                files.map(async (file: any) => {
                    try {
                        const contentUrl = `${DEMOS_BASE_URL}/${file.contentUrl}`;
                        const content = await fetchHtml(contentUrl);
                        return `=== ${file.name} ===\n${content}`;
                    } catch {
                        return `=== ${file.name} ===\n[Error fetching file]`;
                    }
                })
            );

            return {
                content: [{
                    type: "text",
                    text: fileContents.join('\n\n'),
                }],
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