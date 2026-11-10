import {Ipc} from '@opencode/plugin/gui'
import {Schema} from 'effect'

export const PilotOwner=Ipc.define({
  id:'ai-team-chat.owner',
  methods:{publishPlan:{input:Schema.Struct({sessionID:Schema.String,directory:Schema.String,planJSON:Schema.String}),output:Schema.Boolean},authorizeCreate:{input:Schema.Struct({sessionID:Schema.String,directory:Schema.String}),output:Schema.Boolean},send:{input:Schema.Struct({sessionID:Schema.String,directory:Schema.String,recipient:Schema.String,text:Schema.String,requestID:Schema.String}),output:Schema.Boolean},selectModel:{input:Schema.Struct({sessionID:Schema.String,directory:Schema.String,teamID:Schema.String,memberID:Schema.optional(Schema.String),targetSessionID:Schema.String,generation:Schema.String,requestID:Schema.String,expectedModelJSON:Schema.String,modelJSON:Schema.String}),output:Schema.Boolean},acknowledgeComposer:{input:Schema.Struct({sessionID:Schema.String,directory:Schema.String,teamID:Schema.String,targetSessionID:Schema.String,generation:Schema.String,requestID:Schema.String,modelJSON:Schema.String}),output:Schema.Boolean},revokeCapability:{input:Schema.Struct({directory:Schema.optional(Schema.String),teamID:Schema.optional(Schema.String)}),output:Schema.Boolean}}
})
