import assert from 'node:assert/strict';
import { makeClient, API } from './client.js';
export const ROOM_CODE='CTRLROOM0001',TOKEN='offline-fixture-token',NOW='2026-10-22T05:00:00.000Z';
export const OWNER='22222222-2222-4222-8222-222222222222',PERSON='11111111-1111-4111-8111-111111111111',ROOM_ID='33333333-3333-4333-8333-333333333333';
export const ZERO='00000000-0000-0000-0000-000000000000';
export const id=n=>`01990000-0000-7000-8000-${String(n).padStart(12,'0')}`;
export const POLICY={pauseAction:1,resumeAction:2,cancelAction:3,controllers:[PERSON]};
export const JOB={runId:'demo-001',items:[{id:'one',text:'hello'},{id:'two',text:'from'},{id:'three',text:'pingroom'}]};
export function mockSource() {
  const room={id:ROOM_ID,invite_code:ROOM_CODE,type:'standard',is_public:false,members:[{user_id:OWNER},{user_id:PERSON}]};
  const source={rooms:[room],actions:['Pause','Resume','Cancel'].map((label,i)=>({id:id(i+10000),action_number:i+1,label,input_type:'none'})),events:[],requests:[],scripted:[],fail:false};
  let next=0;
  source.add=(kind,extra={})=>{
    const event={id:id(++next),created_at:NOW,action_number:{pause:1,resume:2,cancel:3}[kind],sender:{id:PERSON},room:{code:ROOM_CODE},trigger_source:'manual',origin_agent:null,question:null,is_handoff:false,...extra};
    source.events.push(event);return event;
  };
  source.client=makeClient({token:TOKEN,fetchImpl:async (input,init)=>{
    const u=new URL(input);assert.equal(u.origin,API);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${TOKEN}`);
    source.requests.push({path:u.pathname,after:u.searchParams.get('after')});
    if(source.fail) throw new Error('Fixture read failure');
    if(u.pathname==='/api/agent/rooms')return Response.json(source.rooms);
    if(u.pathname===`/api/agent/rooms/${ROOM_CODE}/actions`)return Response.json(source.actions);
    if(u.pathname==='/api/agent/notifications/wait'){
      assert.equal(u.searchParams.get('timeout'),'0');assert.equal(u.searchParams.get('limit'),'50');
      if(source.scripted.length){const next=source.scripted.shift();if(next instanceof Error)throw next;return Response.json(next);}
      const after=u.searchParams.get('after');
      if(after===null)return Response.json({notifications:[],cursor:source.events.at(-1)?.id??ZERO});
      const notifications=source.events.filter(e=>e.id>after && e.sender.id!==OWNER).slice(0,50);
      return Response.json({notifications,cursor:notifications.at(-1)?.id??after});
    }
    throw new Error('Unexpected route');
  }});
  return source;
}
