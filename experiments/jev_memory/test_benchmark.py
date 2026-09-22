import copy
import unittest
from unittest.mock import patch
import benchmark as b


class MemoryBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.docs, self.cases = b.fixtures()
        self.case = self.cases[0]
        self.packet = b.packets(self.docs, [self.case])[0]

    def test_scope_permissions_forgetting_and_dates(self):
        found = b.shortlist(self.docs, self.case)
        self.assertEqual({d['id'] for d in found}, {'atlas_current', 'atlas_chatter'})
        historical = b.shortlist(self.docs, self.cases[2])
        self.assertEqual([d['id'] for d in historical], ['atlas_old'])
        boundary = self.case | {'as_of': '2026-09-01'}
        self.assertNotIn('atlas_old', [d['id'] for d in b.shortlist(self.docs, boundary)])

    def test_empty_query_is_no_result(self):
        self.assertEqual(b.shortlist(self.docs, self.case | {'query': '?!'}), [])

    def test_no_labels_or_restricted_sources_sent(self):
        for packet in b.packets(self.docs, self.cases):
            self.assertNotIn('gold', packet)
            for source in packet['candidates']:
                self.assertEqual(source['project'], packet['project'])
                self.assertEqual(source['state'], 'accepted')
                self.assertTrue({'jev','composer'} <= set(source['providers']))

    def answer(self):
        return dict(type='choice', choice='none', confidence=1.0,
                    probabilities={'atlas_current':0.0, 'atlas_chatter':0.0, 'none':1.0})

    def test_abstention_is_valid(self):
        self.assertIsNone(b.validate_choice(self.answer(), self.packet))

    def test_malformed_answers_rejected(self):
        for change in [{'choice': []}, {'choice':'outside'}, {'confidence':float('nan')},
                       {'confidence':True}, {'probabilities':{'none':1.0}},
                       {'choice':'atlas_current'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                b.validate_choice(self.answer() | change, self.packet)

    def test_missing_key_never_calls_network(self):
        with patch.dict(b.os.environ, {}, clear=True), patch.object(b.urllib.request, 'urlopen') as call:
            with self.assertRaises(RuntimeError):
                b.jev([self.packet])
            call.assert_not_called()

    def test_service_failure_not_scored_as_abstention(self):
        summary = b.report(self.cases, {'failed':{}}, b.packets(self.docs,self.cases))
        for split in summary.values():
            self.assertEqual(split['failed']['correct'], 0)
            self.assertEqual(split['failed']['abstention_correct'], 0)

if __name__ == '__main__':
    unittest.main()
