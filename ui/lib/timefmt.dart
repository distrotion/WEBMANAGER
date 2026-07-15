/// Format a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS", no zone) as the
/// viewer's LOCAL time. The DB stores UTC (datetime('now')); this converts for
/// display so times read correctly in the local timezone (e.g. Asia/Bangkok +7).
String localTime(dynamic ts) {
  final s = ts?.toString() ?? '';
  if (s.isEmpty) return '';
  try {
    final utc = DateTime.parse('${s.replaceFirst(' ', 'T')}Z'); // mark as UTC
    final l = utc.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${l.year}-${two(l.month)}-${two(l.day)} ${two(l.hour)}:${two(l.minute)}:${two(l.second)}';
  } catch (_) {
    return s;
  }
}
