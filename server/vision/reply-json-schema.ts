/** 生成时约束结构；身份完整性、status/verdict关系和业务语义仍须返回后校验。 */
export function replyJsonSchema(ids:string[]){
  const difference={type:'object',additionalProperties:false,properties:{category:{type:'string',enum:['text','logo','shape','color','other']},message:{type:'string'},lineIndex:{type:['integer','null'],minimum:0},referenceText:{type:['string','null']},sampleText:{type:['string','null']}},required:['category','message','lineIndex','referenceText','sampleText']};
  return {type:'object',additionalProperties:false,properties:{items:{type:'array',minItems:ids.length,maxItems:ids.length,items:{type:'object',additionalProperties:false,
    properties:{componentId:{type:'string',enum:ids},status:{type:'string',enum:['decided','unreadable']},verdict:{enum:['PASS','FAIL',null]},lines:{type:'array',items:{type:'string'}},confidence:{type:['number','null'],minimum:0,maximum:1},reason:{type:'string'},features:{type:'array',items:{type:'string'}},differences:{type:'array',items:difference}},
    required:['componentId','status','verdict','lines','confidence','reason','features','differences']}},instructionConflicts:{type:'array',items:{type:'string'}}},required:['items','instructionConflicts']};
}
