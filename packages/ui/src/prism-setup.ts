import Prism from "prismjs";

// Core languages (auto-included by Prism core): markup, css, clike, javascript

// Import additional languages — order matters for dependencies
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-shell-session";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-go";
import "prismjs/components/prism-java";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-markup-templating"; // required by prism-php
import "prismjs/components/prism-php";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-nginx";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-git";
import "prismjs/components/prism-regex";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-elixir";
import "prismjs/components/prism-hcl";

// Language aliases
Prism.languages.sh = Prism.languages.bash;
Prism.languages.zsh = Prism.languages.bash;
Prism.languages.ts = Prism.languages.typescript;
Prism.languages.js = Prism.languages.javascript;
Prism.languages.py = Prism.languages.python;
Prism.languages.rb = Prism.languages.ruby;
Prism.languages.yml = Prism.languages.yaml;
Prism.languages.dockerfile = Prism.languages.docker;
Prism.languages.tf = Prism.languages.hcl;
Prism.languages.terraform = Prism.languages.hcl;

export { Prism };

/** Highlight code string. Returns HTML string or null if language unknown or code is too large. */
export function highlightCode(code: string, lang: string): string | null {
  // Skip highlighting for very large blocks to avoid lag
  if (code.length > 10_000) return null;
  const grammar = Prism.languages[lang.toLowerCase()];
  if (!grammar) return null;
  return Prism.highlight(code, grammar, lang.toLowerCase());
}
