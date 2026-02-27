
# Kendo UI for Angular - Unofficial MCP Server

A free, open-source **Model Context Protocol (MCP)** server that allows AI assistants (like Claude, Roo Code, and Cline) to browse, search, and extract code examples directly from the public [Kendo UI for Angular documentation](https://www.telerik.com/kendo-angular-ui/components/).

This project serves as a community-driven, accessible alternative to official premium MCPs, enabling developers to harness the power of LLMs with Kendo UI without requiring a subscription for the documentation integration.

## Features

-   🚀 **Zero Configuration:** Works via standard input/output (`stdio`), meaning no network ports or complex setups are required.

-   🧠 **Extremely Token-Optimized:** Utilizes an advanced tree-grouping algorithm to compress component indexes. Shared data files in demos are automatically truncated to type definitions + a single sample record, reducing token consumption by up to **91%** compared to raw output.

-   🔬 **AST-Based Parsing:** Reads documentation directly from Gatsby's `page-data.json` AST instead of scraping rendered HTML. This produces cleaner Markdown, eliminates CSS selector fragility, and reduces the fetch payload significantly. Falls back to HTML scraping with Cheerio if the AST is unavailable.

-   💻 **Live Demo Code Extraction:** Automatically discovers demo examples embedded in documentation pages and exposes their source code. The AI can fetch real, runnable Angular code from any documented feature.

-   ⚡ **In-Memory Caching:** Prevents rate-limiting and speeds up AI responses by caching fetched documentation for 24 hours.

-   🛡️ **Type-Safe:** Built with the latest high-level `@modelcontextprotocol/sdk` and `zod` for strict parameter validation.


## Available Tools

This server exposes five specialized tools to the AI:

1.  `list_kendo_components` — Lists all available Kendo Angular components (e.g., Grid, Buttons, Dropdowns).

2.  `list_component_topics` — Given a component ID, retrieves its documentation index/topics (e.g., Data Binding, Filtering, Editing). Filters out deep API references to keep context clean.

3.  `list_component_api` — Retrieves deep API references for a component: `@Input()`, `@Output()`, classes, directives, and interfaces.

4.  `read_kendo_doc` — Reads a specific documentation article and returns it as clean Markdown. Includes a list of available demo examples at the end that can be fetched with `read_demo_source`.

5.  `read_demo_source` — Fetches the source code files for a specific demo example. Returns the full component code and intelligently truncates large shared data files to their type definitions + one sample record.

## Usage with Claude Desktop

You don't need to clone the repository if you just want to use it. You can run it directly via `npx` (requires Node.js installed on your machine).

Add the following configuration to your Claude Desktop config file:

-   **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

-   **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`


```json
{
  "mcpServers": {
    "kendo-angular-unofficial": {
      "command": "npx",
      "args": [
        "-y",
        "kendo-angular-unofficial-mcp"
      ]
    }
  }
}

```

_Note: Restart Claude Desktop after updating the configuration._

## Usage with VS Code (Cline / Roo Code)

If you are using VS Code with an MCP-compatible AI extension like **Cline** or **Roo Code**, you can easily add this server:

1.  Open the Command Palette (`Ctrl + Shift + P` or `Cmd + Shift + P`).

2.  Search for `Cline: MCP Servers` (or your extension's equivalent) to open the `cline_mcp_settings.json` file.

3.  Add the following configuration:


```json
{
  "mcpServers": {
    "kendo-angular-unofficial": {
      "command": "npx",
      "args": [
        "-y",
        "kendo-angular-unofficial-mcp"
      ]
    }
  }
}

```

## Local Development & Installation

If you want to contribute, modify the scraping logic, or run it locally from source:

1.  **Clone the repository:**

    ```shell
    git clone https://github.com/EremesNG/kendo-angular-unofficial-mcp.git
    cd kendo-angular-unofficial-mcp
    
    ```

2.  **Install dependencies:**

    ```shell
    npm install
    
    ```

3.  **Build the TypeScript code:**

    ```shell
    npm run build
    
    ```

4.  **Connect your local build to your AI Client:** Edit your MCP settings file (Claude Desktop or VS Code) to point to your local Node instance. _Note: If you are on Windows, remember to escape your backslashes (e.g., `C:\\path\\to\\dist\\index.js`)._

    ```json
    {
      "mcpServers": {
        "kendo-angular-local": {
          "command": "node",
          "args": [
            "/absolute/path/to/kendo-angular-unofficial-mcp/dist/index.js"
          ]
        }
      }
    }
    
    ```


## Prompt Examples

Once connected, you can ask your AI assistant things like:

-   _"Can you check the Kendo UI documentation and tell me what components are available?"_

-   _"Read the Kendo Angular Grid excel export documentation and write a component that implements a custom fetchData callback."_

-   _"Use the Kendo API tool to check what @Input properties are available for the `<kendo-grid-column>` component."_

-   _"Read the Grid filtering docs and fetch the demo source code so I can see a working example."_

## Disclaimer

This is an unofficial, community-driven project. It is **not** affiliated with, endorsed by, or sponsored by Progress Software Corporation. Kendo UI and Telerik are trademarks of Progress Software Corporation. This tool solely extracts publicly available information from the web for educational and developmental purposes.