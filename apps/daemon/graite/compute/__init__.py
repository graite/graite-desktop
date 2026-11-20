"""Using another of your own computers for AI, over the sync connection.

One computer serves (it has the models and the switch on); the others call it. A call is a
request and a streamed reply between two devices that sync the same vault, sealed with that
vault's key like every other message between them, so Graite Cloud passes it on without
being able to read it. `service.py` is the calling and answering machinery, `serve.py` what
a serving computer does with a call, `transport.py` how chat reaches it.
"""
