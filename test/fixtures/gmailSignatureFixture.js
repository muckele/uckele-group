// A Gmail signature shaped like a real one (bold name/title/company lines, a phone icon image
// with its number, a mailto: link, a website link, a hosted logo, a table layout), with
// placeholder values only.
export const GMAIL_SIGNATURE_FIXTURE_HTML = [
  '<div dir="ltr"><table cellpadding="0" cellspacing="0" border="0" style="color:rgb(34,34,34);font-family:Arial,sans-serif">',
  '<tbody><tr>',
  '<td valign="top" width="110" style="padding-right:12px">',
  '<img src="https://ci3.googleusercontent.com/mail-sig/AIorK4example-logo" alt="Example Co. logo" width="96" height="96" data-image-whitelisted="" class="CToWUd">',
  '</td>',
  '<td valign="top">',
  '<div><b><font color="#1a1a1a" size="4">Pat Example</font></b></div>',
  '<div><b>President</b></div>',
  '<div><b>Example Holdings LLC</b></div>',
  '<div><img src="https://ci3.googleusercontent.com/mail-sig/AIorK4phone-icon" width="12" height="12">&nbsp;(555) 010-0000</div>',
  '<div><a href="mailto:pat@example.com" target="_blank" onclick="track()">pat@example.com</a></div>',
  '<div><a href="https://www.example.com/" target="_blank" rel="noopener">www.example.com</a></div>',
  '</td>',
  '</tr></tbody></table></div>',
].join('');

export const GMAIL_SIGNATURE_FIXTURE_TEXT = [
  'Pat Example',
  'President',
  'Example Holdings LLC',
  '(555) 010-0000',
  'pat@example.com',
  'www.example.com',
].join('\n');
