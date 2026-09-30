import unittest

from helm_worker_runtime import Worker


class SecretRedactionTests(unittest.TestCase):
    def test_redacts_escaped_credentials_in_values_and_keys(self) -> None:
        ingress, episode = 'ingress"\\secret', 'episode"\\secret'
        worker = Worker(
            "test",
            (),
            None,
            ingress_token=ingress,
            env={"HELM_EPISODE_TOKEN": episode},
        )
        self.assertEqual(
            worker.safe({ingress: [episode, {"text": f"token={ingress}"}, 4]}),
            {"[REDACTED]": ["[REDACTED]", {"text": "token=[REDACTED]"}, 4]},
        )
