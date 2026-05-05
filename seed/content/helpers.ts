interface Slide { title: string; order: number; content: string; type?: string; }
interface Quiz { text: string; type: string; options: {text: string; isCorrect: boolean}[]; explanation: string; order: number; }

function h2(t: string): string { return `<h2>${t}</h2>`; }
function p(t: string): string { return `<p>${t}</p>`; }
function ul(items: string[]): string { return '<ul>' + items.map(i => `<li>${i}</li>`).join('') + '</ul>'; }
function ol(items: string[]): string { return '<ol>' + items.map(i => `<li>${i}</li>`).join('') + '</ol>'; }
function tip(t: string): string { return `<div class="tip"><strong>Tip:</strong> ${t}</div>`; }
function warn(t: string): string { return `<div class="warning"><strong>Important:</strong> ${t}</div>`; }
function action(t: string): string { return `<div class="step-action"><strong>Try it:</strong> ${t}</div>`; }
function table(headers: string[], rows: string[][]): string {
  return '<table><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>' +
    rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</table>';
}

function buildSlide(order: number, title: string, ...parts: string[]): Slide {
  return { title, order, content: parts.join(''), type: 'text' };
}

export { Slide, Quiz, buildSlide, h2, p, ul, ol, tip, warn, action, table };
