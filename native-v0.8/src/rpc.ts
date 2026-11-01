import { Rpc } from "@opencode/plugin/rpc"
const directory = {type:"string",minLength:1}
const object = {type:"object",additionalProperties:true}
const errors={operation_failed:{type:"object",properties:{reason:{type:"string"}},required:["reason"],additionalProperties:false}}

export const TeamChatRPC = Rpc.define({
  id:"ai-team-chat",
  events:{changed:{schema:{type:'object',properties:{directory:{type:'string'}},required:['directory'],additionalProperties:false}}},
  methods:{
    execution:{input:{type:"object",properties:{directory,maxWorkers:{type:"integer",minimum:1,maximum:4},providerLimits:{type:"object",additionalProperties:{type:"integer",minimum:1,maximum:5}}},required:["directory","maxWorkers","providerLimits"],additionalProperties:false},output:object,errors},
    models:{input:{type:"object",properties:{directory,action:{type:"string",enum:["list","change"]},role:{type:"string",enum:["admin","frontend","backend","devops","qa"]},providerID:{type:"string",minLength:1},modelID:{type:"string",minLength:1},variant:{type:"string",minLength:1},saveDefault:{type:"boolean"}},required:["directory","action"],additionalProperties:false},output:object,errors},
    workspace:{input:{type:"object",properties:{directory,sessionID:{type:"string"},action:{type:"string",enum:["owner_request","owner_requests","owner_request_update","owner_requests_expire","task_discussion","assign_batch","batch_status","aws_propose","aws_request","aws_confirm","environment","approve_build","build","approve_coding","backup","restore","upload","list","read","download","share","task","tasks","update","blocker","artifact","review","monitor"]},payload:{type:"object",additionalProperties:true}},required:["directory","action","payload"],additionalProperties:false},output:object,errors:{operation_failed:{type:"object",properties:{reason:{type:"string"}},required:["reason"],additionalProperties:false}}},
    memberSend:{input:{type:"object",properties:{directory,sessionID:{type:"string"},recipient:{type:"string"},text:{type:"string",minLength:1,maxLength:10000},kind:{type:"string",enum:["execution","control"]},taskID:{type:"string",minLength:1},idempotencyKey:{type:"string",minLength:1,maxLength:160}},required:["directory","sessionID","recipient","text"],additionalProperties:false},output:object,errors},
    memberInbox:{input:{type:"object",properties:{directory,sessionID:{type:"string"}},required:["directory","sessionID"],additionalProperties:false},output:object},
    createTeam:{
      errors:{setup_failed:{type:"object",properties:{reason:{type:"string"}},required:["reason"],additionalProperties:false}},
      input:{type:"object",properties:{directory,name:{type:"string",minLength:1,maxLength:80}},required:["directory"],additionalProperties:false},
      output:object,
    },
    snapshot:{
      input:{type:"object",properties:{directory},required:["directory"],additionalProperties:false},
      output:object,
    },
    sync:{
      input:{type:"object",properties:{directory},required:["directory"],additionalProperties:false},
      output:object,
    },
    send:{
      errors,
      input:{type:"object",properties:{directory,recipient:{type:"string",enum:["admin","frontend","backend","devops","qa"]},text:{type:"string",minLength:1,maxLength:10000}},required:["directory","recipient","text"],additionalProperties:false},
      output:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}
    }
  }
})
