DELETE FROM rag_events;
DELETE FROM rag_totals;
DELETE FROM rag_roasts;
DELETE FROM sqlite_sequence WHERE name = 'rag_events';
DELETE FROM sqlite_sequence WHERE name = 'rag_roasts';
