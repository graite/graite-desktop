"""The personal assistant: one named agent per vault that talks with the user, remembers
them in ordinary pages and keeps working on their goals in the background.

Its definition is an `_agents/*.md` file with `assistant: true`; its memory is a page subtree
the user can read and edit. Everything it changes goes through `propose_*`, so page policy
applies to it like to any other agent.
"""
