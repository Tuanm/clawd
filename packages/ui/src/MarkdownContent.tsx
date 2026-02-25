import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import "katex/dist/katex.min.css";
import { PreBlock, MermaidDiagram, Callout } from "./MessageList";

interface MarkdownContentProps {
  content: string;
}

export default function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, rehypeRaw]}
      components={{
        pre: ({ children }) => <PreBlock>{children}</PreBlock>,
        code: ({ className, children }) => {
          const match = /language-(\w+)/.exec(className || "");
          const lang = match ? match[1] : "";
          const code = String(children).replace(/\n$/, "");

          if (lang === "mermaid") {
            return <MermaidDiagram chart={code} />;
          }

          return <code className={className}>{children}</code>;
        },
        blockquote: ({ children }) => {
          const firstChild = (children as any)?.[0];
          if (firstChild?.props?.children) {
            const text = String(firstChild.props.children);
            const calloutMatch = text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
            if (calloutMatch) {
              const type = calloutMatch[1].toLowerCase();
              const content = text.replace(calloutMatch[0], "");
              return <Callout type={type}>{content}</Callout>;
            }
          }
          return <blockquote>{children}</blockquote>;
        },
        table: ({ children }) => (
          <div className="table-wrapper">
            <table>{children}</table>
          </div>
        ),
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        input: ({ type, checked, ...props }) => {
          if (type === "checkbox") {
            return <input type="checkbox" checked={checked} disabled className="task-checkbox" />;
          }
          return <input type={type} {...props} />;
        },
      }}
    >
      {content}
    </Markdown>
  );
}
